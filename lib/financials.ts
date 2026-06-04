// lib/financials.ts — Mark's read-only window into the company P&L.
//
// Mark holds NO Xero keys (by design). The actual P&L pull runs on the
// payroll-poster box (where the SC + CQ Xero keys live) at its /financials
// endpoint. This module is a thin authenticated fetch helper used by the
// Q&A path (and later the monthly pack) so Mark can answer profit / income /
// expense questions per entity with REAL figures instead of a blank prompt.
//
// IMPORTANT (arrears distortion): JBC bills most care in arrears, so the
// CURRENT and most-recent month's income is under-booked until invoicing
// catches up — a recent month can look like a huge "loss" that isn't real.
// We flag the partial/most-recent months so Mark warns rather than alarms.

import { env } from "./env";
import { prisma } from "./prisma";

export interface MonthPL {
  month: string; // "2026-04"
  from: string;
  to: string;
  partialMonthToDate: boolean;
  totalIncome: number | null;
  totalCostOfSales: number | null;
  grossProfit: number | null;
  totalOperatingExpenses: number | null;
  netProfit: number | null;
}

export interface TenantFinancials {
  tenant: string; // "SC" | "CQ"
  asOf: string;
  months: MonthPL[];
}

export interface FinancialsResult {
  ok: boolean;
  error?: string;
  // Per-entity series plus a derived consolidated (management view only).
  SC?: TenantFinancials;
  CQ?: TenantFinancials;
  consolidated?: { month: string; partialMonthToDate: boolean; netProfit: number | null; totalIncome: number | null }[];
}

/** Build a management-view consolidated net-profit/income series by summing the
 *  two entities month-by-month. Consolidated is for insight only — never for
 *  statutory use (separate taxpayers). A month is partial if EITHER entity's is. */
function consolidate(sc?: TenantFinancials, cq?: TenantFinancials) {
  const byMonth = new Map<string, { partial: boolean; net: number | null; income: number | null }>();
  const add = (t?: TenantFinancials) => {
    if (!t) return;
    for (const m of t.months) {
      const cur = byMonth.get(m.month) ?? { partial: false, net: 0, income: 0 };
      cur.partial = cur.partial || m.partialMonthToDate;
      cur.net = (cur.net ?? 0) + (m.netProfit ?? 0);
      cur.income = (cur.income ?? 0) + (m.totalIncome ?? 0);
      byMonth.set(m.month, cur);
    }
  };
  add(sc);
  add(cq);
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({
      month,
      partialMonthToDate: v.partial,
      netProfit: v.net == null ? null : Math.round(v.net * 100) / 100,
      totalIncome: v.income == null ? null : Math.round(v.income * 100) / 100,
    }));
}

// ── In-process cache ────────────────────────────────────────────────────────
// The poster's /financials pull hits Xero live and takes ~9s. That's the single
// biggest source of latency on a voice turn (Mark re-pulled 4 months of P&L on
// EVERY spoken sentence). The P&L barely moves minute-to-minute, so we cache the
// last good result per monthsBack for a short TTL and serve repeat turns
// instantly. A failed pull is NOT cached (so we retry next turn). Cache lives in
// module memory — shared across requests on a warm instance, which covers the
// rapid-fire turns within a single voice call. Cold starts simply re-pull once.
const FINANCIALS_TTL_MS = 5 * 60 * 1000; // 5 minutes
type CacheEntry = { at: number; value: FinancialsResult };
const financialsCache = new Map<number, CacheEntry>();

/** Fetch the last `monthsBack` full months + current month-to-date P&L for both
 *  entities from the poster. Non-fatal: returns { ok:false } on any problem so
 *  the Q&A path can still answer from findings without crashing.
 *
 *  Cached for FINANCIALS_TTL_MS to keep voice turns fast. Pass
 *  `{ force: true }` to bypass the cache (e.g. a "refresh the numbers" intent). */
export async function fetchFinancials(
  monthsBack = 4,
  opts?: { force?: boolean },
): Promise<FinancialsResult> {
  if (!env.PAYROLL_POSTER_URL || !env.PAYROLL_POSTER_API_KEY) {
    return { ok: false, error: "financials feed not wired (poster URL/key missing)" };
  }

  if (!opts?.force) {
    const hit = financialsCache.get(monthsBack);
    if (hit && Date.now() - hit.at < FINANCIALS_TTL_MS) {
      return hit.value;
    }
  }

  const base = env.PAYROLL_POSTER_URL.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/financials?tenant=both&months=${monthsBack}`, {
      headers: { Authorization: `Bearer ${env.PAYROLL_POSTER_API_KEY}` },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; tenants?: { SC?: TenantFinancials; CQ?: TenantFinancials }; error?: string }
      | null;
    if (!res.ok || !data?.ok || !data.tenants) {
      return { ok: false, error: data?.error || `financials pull failed (${res.status})` };
    }
    const sc = data.tenants.SC;
    const cq = data.tenants.CQ;
    const value: FinancialsResult = { ok: true, SC: sc, CQ: cq, consolidated: consolidate(sc, cq) };
    financialsCache.set(monthsBack, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { ok: false, error: `could not reach financials reader: ${(e as Error).message}` };
  }
}

// ── DB-first reader (the Xero-credit saver) ─────────────────────────────────
// Re-pulling CLOSED months from Xero is pure waste — they never change, and the
// poster's /financials pull costs ~4 months x 2 entities = 8 Xero calls against
// an uncertified ~1000/day-per-entity cap. So:
//   1. Read every stored closed month from MonthlyFinancials (uploaded once on
//      the /financials page from Tony's Xero P&L export) — ZERO Xero calls.
//   2. Pull ONLY the current, still-moving month live from the poster
//      (months=1) — 1 P&L per entity, cached 5 min — so today's figure stays
//      fresh without re-fetching history.
//   3. Merge (live current month overrides any stored copy of the same month).
// The payload is tiny (24 months x 2 entities x 6 numbers ≈ a few KB) so Mark
// gets FULL history in his prompt at almost no token or Xero cost.

/** Brisbane "YYYY-MM" for the current month. */
function currentMonthKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${y}-${m}`;
}

function dbRowToMonthPL(r: {
  month: string;
  totalIncome: number | null;
  totalCostOfSales: number | null;
  grossProfit: number | null;
  totalOperatingExpenses: number | null;
  netProfit: number | null;
}): MonthPL {
  return {
    month: r.month,
    from: `${r.month}-01`,
    to: `${r.month}-01`,
    partialMonthToDate: false,
    totalIncome: r.totalIncome,
    totalCostOfSales: r.totalCostOfSales,
    grossProfit: r.grossProfit,
    totalOperatingExpenses: r.totalOperatingExpenses,
    netProfit: r.netProfit,
  };
}

/**
 * Financials for Mark's Q&A and the profit report. Reads stored history from
 * the DB (no Xero calls) and overlays only the live current month. This is the
 * function the brain should use — fetchFinancials() (live, all months) is kept
 * for the rare "force a full live refresh" case.
 *
 * Non-fatal: if the live current-month pull fails we still return stored
 * history with ok:true (Mark just won't have today's partial figure). If there
 * is NO stored history AND the live pull fails, returns ok:false.
 */
export async function getFinancialsForQa(): Promise<FinancialsResult> {
  const curKey = currentMonthKey();

  // 1. Stored closed months from DB (zero Xero calls).
  let scMonths: MonthPL[] = [];
  let cqMonths: MonthPL[] = [];
  try {
    const rows = await prisma.monthlyFinancials.findMany({
      orderBy: { month: "asc" },
    });
    for (const r of rows) {
      const pl = dbRowToMonthPL(r);
      if (r.entityCode === "SC") scMonths.push(pl);
      else if (r.entityCode === "CQ") cqMonths.push(pl);
    }
  } catch {
    // DB unreachable — fall through; live pull may still rescue us.
  }

  // 2. Live current month only (1 P&L per entity), reusing the 5-min cache.
  const live = await fetchFinancials(1);
  if (live.ok) {
    const overlay = (stored: MonthPL[], tf?: TenantFinancials): MonthPL[] => {
      const liveCur = tf?.months?.find((m) => m.month === curKey) ?? tf?.months?.[0];
      if (!liveCur) return stored;
      const filtered = stored.filter((m) => m.month !== liveCur.month);
      return [...filtered, liveCur].sort((a, b) => a.month.localeCompare(b.month));
    };
    scMonths = overlay(scMonths, live.SC);
    cqMonths = overlay(cqMonths, live.CQ);
  }

  if (!scMonths.length && !cqMonths.length) {
    return {
      ok: false,
      error: live.ok ? "no stored history and no live months" : live.error,
    };
  }

  const asOf = new Date().toISOString();
  const sc: TenantFinancials | undefined = scMonths.length
    ? { tenant: "SC", asOf, months: scMonths }
    : undefined;
  const cq: TenantFinancials | undefined = cqMonths.length
    ? { tenant: "CQ", asOf, months: cqMonths }
    : undefined;

  return { ok: true, SC: sc, CQ: cq, consolidated: consolidate(sc, cq) };
}
