// GET /api/ops-snapshot — live finance snapshot for the "MARK" wall dashboard.
//
// A standalone, client-side dashboard (different origin) polls this every few
// seconds and renders the result. Because it runs in a browser it cannot hold a
// powerful secret, so this endpoint is gated by a *read-only scoped bearer
// token* (MARK_DASHBOARD_TOKEN) that can read this snapshot and nothing else —
// exposure in the page is harmless. CORS + OPTIONS preflight are handled here.
//
// This route is added to BYPASS_PREFIXES in proxy.ts so the app-wide HTTP Basic
// gate doesn't intercept it; it self-auths with the bearer token below.
//
// Every field is best-effort and grounded in real Mark data where available
// (latest cash-forecast snapshot, specialist findings, run status, goal
// metrics, monthly financials). Anything we can't source is simply omitted —
// the UI keeps its last value. The handler never throws: on any error it
// returns `{}` with CORS headers so the dashboard poll degrades gracefully.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildForecast, type CashForecastState } from "@/lib/cash-forecast";

export const dynamic = "force-dynamic";

// ---- CORS ---------------------------------------------------------------
// Bearer-token auth (not cookies), so a wildcard origin is safe. Override with
// MARK_DASHBOARD_ORIGIN to pin to the exact dashboard origin if preferred.
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": process.env.MARK_DASHBOARD_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function unauthorized() {
  return NextResponse.json(
    { error: "unauthorized" },
    { status: 401, headers: corsHeaders() },
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round = (n: number, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

// 13 forecast weeks ≈ 3 calendar months.
const WEEKS_PER_MONTH = 52 / 12;
const MONTHS_IN_13W = 13 / WEEKS_PER_MONTH; // ≈ 3.0

export async function GET(req: NextRequest) {
  const expected = process.env.MARK_DASHBOARD_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "dashboard token not configured" },
      { status: 503, headers: corsHeaders() },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== expected) return unauthorized();

  try {
    const body = await buildSnapshot();
    return NextResponse.json(body, {
      headers: { ...corsHeaders(), "Cache-Control": "no-store" },
    });
  } catch {
    // Never 500 a polling dashboard — return empty so it keeps last values.
    return NextResponse.json({}, { headers: corsHeaders() });
  }
}

// ---- Snapshot assembly --------------------------------------------------

type Snapshot = {
  cash?: number;
  target?: number;
  runway?: number;
  burn?: number;
  inflowToday?: number;
  outflowToday?: number;
  coverage?: number;
  risk?: { score: number; anomalies: number };
  compliance?: Array<{ label: string; detail: string; status: string; level: "ok" | "warn" | "crit" }>;
  vitals?: Array<{ label: string; pct: number }>;
  transactions?: Array<{ label: string; dir: "IN" | "OUT" | "FX"; amount: number; status: string }>;
  logs?: Array<{ time: string; level: "OK" | "INFO" | "WARN" | "CRIT"; message: string }>;
  radar?: Array<{ x: number; y: number; size: number; level: "ok" | "warn" | "crit" }>;
};

// Brisbane (UTC+10, no DST) HH:MM:SS for log timestamps.
function brisbaneTime(d: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

const SPECIALIST_LABELS: Record<string, string> = {
  reconciliation: "BANK RECONCILIATION",
  "controls-audit": "CONTROLS & AUDIT",
  "payroll-labour": "PAYROLL & LABOUR",
  payables: "PAYABLES / AP",
  "revenue-claims": "REVENUE & CLAIMS",
  receivables: "RECEIVABLES / AR",
  "tax-compliance": "TAX & COMPLIANCE",
};

async function buildSnapshot(): Promise<Snapshot> {
  const now = new Date();
  const snap: Snapshot = {};

  const [forecastRow, openFindings, recentFindings, runStatuses, goals, latestFin] =
    await Promise.all([
      prisma.cashForecastSnapshot.findFirst({ orderBy: { asOfDate: "desc" } }),
      prisma.ingestedFinding.findMany({
        where: { resolved: false },
        select: { severity: true, entityCode: true, amount: true },
      }),
      prisma.ingestedFinding.findMany({
        where: { resolved: false },
        orderBy: { ingestedAt: "desc" },
        take: 9,
        select: { severity: true, title: true, ingestedAt: true },
      }),
      prisma.specialistRunStatus.findMany(),
      prisma.goalMetric.findMany({
        orderBy: { capturedAt: "desc" },
        distinct: ["metric"],
        where: { entityScope: "consolidated" },
        select: { metric: true, value: true, target: true },
      }),
      prisma.monthlyFinancials.findFirst({ orderBy: { month: "desc" } }),
    ]);

  // --- Cash / target / burn / runway / today flows -----------------------
  let target =
    process.env.MARK_CASH_TARGET != null ? Number(process.env.MARK_CASH_TARGET) : NaN;
  if (forecastRow) {
    try {
      const state = forecastRow.state as unknown as CashForecastState;
      const f = buildForecast(state);
      const cash = f.combined.startingCash;
      snap.cash = round(cash);
      if (!Number.isFinite(target)) target = f.minimumBalanceAlert;

      const out13 = f.combined.summary.totalOutflows13w;
      const in13 = f.combined.summary.totalInflows13w;
      const netMonthlyBurn = (out13 - in13) / MONTHS_IN_13W; // >0 = consuming cash
      snap.burn = round(netMonthlyBurn);
      if (netMonthlyBurn > 0) {
        snap.runway = round(cash / netMonthlyBurn, 1);
      } else {
        snap.runway = 99.9; // cash-generative — no depletion horizon
      }

      // No transaction-level feed yet → expose a 7-day run-rate proxy from
      // week 1 of the forecast. Replace with the Xero bank-transactions pull
      // for a true rolling-24h figure.
      const w1 = f.combined.weeks[0];
      if (w1) {
        snap.inflowToday = round(w1.totalInflows / 7);
        snap.outflowToday = round(w1.totalOutflows / 7);
      }
    } catch {
      /* leave cash fields omitted */
    }
  }
  if (Number.isFinite(target)) snap.target = round(target);

  // --- Risk ---------------------------------------------------------------
  const crit = openFindings.filter((f) => f.severity === "critical").length;
  const warn = openFindings.filter((f) => f.severity === "warning").length;
  const info = openFindings.filter((f) => f.severity === "info").length;
  const riskScore = clamp(crit * 25 + warn * 8 + info * 2, 0, 100);
  snap.risk = { score: round(riskScore), anomalies: openFindings.length };

  // --- Compliance (one row per specialist) --------------------------------
  if (runStatuses.length) {
    const order = Object.keys(SPECIALIST_LABELS);
    const levelFor = (s: string): "ok" | "warn" | "crit" =>
      s === "ok" ? "ok" : s === "exceptions" ? "warn" : "crit";
    const statusWord = (s: string, ex: number): string =>
      s === "ok" ? "CLEAR" : s === "exceptions" ? `${ex} OPEN` : s.toUpperCase();
    snap.compliance = runStatuses
      .slice()
      .sort((a, b) => order.indexOf(a.agent) - order.indexOf(b.agent))
      .map((r) => ({
        label: SPECIALIST_LABELS[r.agent] ?? r.agent.toUpperCase(),
        detail: r.lastRunAt
          ? `last run ${brisbaneTime(r.lastRunAt)}`
          : "never run",
        status: statusWord(r.lastRunStatus, r.exceptionsOpen),
        level: levelFor(r.lastRunStatus),
      }));

    // Coverage = % of specialists that ran cleanly-or-with-exceptions (i.e.
    // ran at all and didn't fail/stale) — a monitoring health figure.
    const healthy = runStatuses.filter(
      (r) => r.lastRunStatus === "ok" || r.lastRunStatus === "exceptions",
    ).length;
    snap.coverage = round((healthy / runStatuses.length) * 100, 2);
  }

  // --- Vitals (0–100 bars) ------------------------------------------------
  const vitals: Snapshot["vitals"] = [];
  if (snap.cash != null && snap.target && snap.target > 0) {
    vitals.push({ label: "RESERVE COVERAGE", pct: round(clamp((snap.cash / snap.target) * 100, 0, 100)) });
  }
  if (latestFin?.totalIncome && latestFin.grossProfit != null) {
    vitals.push({
      label: "GROSS MARGIN",
      pct: round(clamp((latestFin.grossProfit / latestFin.totalIncome) * 100, 0, 100)),
    });
  }
  for (const g of goals) {
    const value = Number(g.value);
    const tgt = g.target != null ? Number(g.target) : null;
    let pct: number | null = null;
    if (g.metric === "labour-cost-pct") pct = clamp(value, 0, 100);
    else if (g.metric === "dso") pct = clamp(value, 0, 100);
    else if (tgt && tgt !== 0) pct = clamp((value / tgt) * 100, 0, 100);
    if (pct != null) vitals.push({ label: g.metric.replace(/-/g, " ").toUpperCase(), pct: round(pct) });
  }
  if (vitals.length) snap.vitals = vitals;

  // --- Logs (newest first, ≤9) — real specialist findings -----------------
  if (recentFindings.length) {
    const lvl = (s: string): "OK" | "INFO" | "WARN" | "CRIT" =>
      s === "critical" ? "CRIT" : s === "warning" ? "WARN" : "INFO";
    snap.logs = recentFindings.map((f) => ({
      time: brisbaneTime(f.ingestedAt),
      level: lvl(f.severity),
      message: f.title,
    }));
  }

  // --- Radar (optional) — open findings plotted by severity ---------------
  if (openFindings.length) {
    const ring = { critical: 0.42, warning: 0.28, info: 0.15 } as Record<string, number>;
    const lvlMap = { critical: "crit", warning: "warn", info: "ok" } as Record<string, "ok" | "warn" | "crit">;
    snap.radar = openFindings.slice(0, 12).map((f, i) => {
      const r = ring[f.severity] ?? 0.2;
      const angle = (i / Math.max(openFindings.length, 1)) * Math.PI * 2;
      return {
        x: round(0.5 + r * Math.cos(angle), 3),
        y: round(0.5 + r * Math.sin(angle), 3),
        size: f.severity === "critical" ? 8 : f.severity === "warning" ? 6 : 4,
        level: lvlMap[f.severity] ?? "ok",
      };
    });
  }

  return snap;
}
