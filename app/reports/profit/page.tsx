// /reports/profit — Mark's first GRAPH report.
//
// Profit & Loss per entity (SC vs CQ) as grouped bars per month, plus a
// consolidated net-profit trend line. Pulls the SAME live Xero P&L feed
// (lib/financials) that Mark cites in Q&A, so the picture on screen and the
// number he says aloud always agree.
//
// ARREARS: JBC bills most care in arrears, so the current month-to-date and
// the single most-recent completed month are under-booked on income and show a
// FALSE loss. Those months are drawn FADED with a clear caveat so nobody reads
// a fake dip as real.
//
// Designed to be screen-popped by Mark's voice ("show me the profit report"):
// server-rendered, no client JS, draws instantly inside an iframe.

import Link from "next/link";
import { fetchFinancials, type MonthPL } from "@/lib/financials";
import { brisbane } from "@/lib/time";
import { env } from "@/lib/env";
import {
  CHART_COLORS,
  fmtAud,
  monthShort,
  groupedBars,
  lineChart,
} from "@/lib/charts";

export const dynamic = "force-dynamic";

export default async function ProfitReportPage() {
  const fin = await fetchFinancials(6);

  if (!fin.ok) {
    return (
      <main className="container">
        <h1>Profit report</h1>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Couldn&apos;t reach the P&amp;L feed right now: {fin.error}. Try again shortly.
          </p>
        </div>
      </main>
    );
  }

  // Union of all months present across both entities, oldest-first.
  const monthSet = new Set<string>();
  fin.SC?.months.forEach((m) => monthSet.add(m.month));
  fin.CQ?.months.forEach((m) => monthSet.add(m.month));
  const months = [...monthSet].sort((a, b) => a.localeCompare(b));

  const byMonth = (t?: { months: MonthPL[] }) => {
    const map = new Map<string, MonthPL>();
    t?.months.forEach((m) => map.set(m.month, m));
    return map;
  };
  const scMap = byMonth(fin.SC);
  const cqMap = byMonth(fin.CQ);

  // A month is "faded" (arrears-distorted) if either entity flags it partial,
  // OR it is the single most-recent completed month (income under-booked until
  // invoicing catches up — memory rule: current + most-recent completed month
  // both show a false loss).
  const partialIdx = new Set<number>();
  months.forEach((m, i) => {
    const sc = scMap.get(m);
    const cq = cqMap.get(m);
    if (sc?.partialMonthToDate || cq?.partialMonthToDate) partialIdx.add(i);
  });
  // The most-recent completed (non-partial) month is also arrears-distorted —
  // fade it and everything after it.
  const lastNonPartial = [...months.keys()].filter((i) => !partialIdx.has(i)).pop();
  if (lastNonPartial != null) {
    for (let i = lastNonPartial; i < months.length; i++) partialIdx.add(i);
  }
  const faded = [...partialIdx];

  // The trustworthy headline = the last month that is NOT faded (last fully
  // settled month — April in the current data).
  const lastSettledIdx = [...months.keys()].filter((i) => !partialIdx.has(i)).pop();

  const cats = months.map(monthShort);
  const W = 720;
  const H = 300;

  const bars = groupedBars({
    categories: cats,
    series: [
      { label: "SC", color: CHART_COLORS.cyan, values: months.map((m) => scMap.get(m)?.netProfit ?? null) },
      { label: "CQ", color: CHART_COLORS.indigo, values: months.map((m) => cqMap.get(m)?.netProfit ?? null) },
    ],
    width: W,
    height: H,
    fadedCategories: faded,
  });

  const consolidatedSeries = (fin.consolidated ?? []).slice().sort((a, b) => a.month.localeCompare(b.month));
  const line = lineChart({
    categories: consolidatedSeries.map((c) => monthShort(c.month)),
    values: consolidatedSeries.map((c) => c.netProfit),
    width: W,
    height: 240,
    color: CHART_COLORS.emerald,
    fadedCategories: consolidatedSeries
      .map((c, i) => (partialIdx.has(months.indexOf(c.month)) ? i : -1))
      .filter((i) => i >= 0),
  });

  // The trustworthy headline = last fully-settled month.
  const settledMonth = lastSettledIdx != null ? months[lastSettledIdx] : null;
  const settledSC = settledMonth ? scMap.get(settledMonth)?.netProfit ?? null : null;
  const settledCQ = settledMonth ? cqMap.get(settledMonth)?.netProfit ?? null : null;
  const settledCombined =
    settledSC == null && settledCQ == null ? null : (settledSC ?? 0) + (settledCQ ?? 0);

  return (
    <main className="container">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ marginBottom: 4 }}>Profit report</h1>
        <nav style={{ display: "flex", gap: 8 }}>
          <Link className="appbar-link" href="/reports/profit" style={{ background: "var(--bg-card)" }}>Profit</Link>
          <Link className="appbar-link" href="/cash-forecast">Cash</Link>
          <Link className="appbar-link" href="/qa">Ask Mark</Link>
        </nav>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Net profit per entity from Xero (AUD). SC and CQ are separate taxpayers — the consolidated
        line is a management view only. As of {fin.SC?.asOf ? brisbane(new Date(fin.SC.asOf)) : "—"}.
      </p>

      {/* Headline KPIs — last fully-settled month */}
      {settledMonth && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 }}>
          <Kpi label={`SC — ${monthShort(settledMonth)}`} value={fmtAud(settledSC)} color={CHART_COLORS.cyan} positive={(settledSC ?? 0) >= 0} />
          <Kpi label={`CQ — ${monthShort(settledMonth)}`} value={fmtAud(settledCQ)} color={CHART_COLORS.indigo} positive={(settledCQ ?? 0) >= 0} />
          <Kpi label={`Combined — ${monthShort(settledMonth)}`} value={fmtAud(settledCombined)} color={CHART_COLORS.emerald} positive={(settledCombined ?? 0) >= 0} />
          <Kpi label="Profit target" value={`$${(env.GOAL_PROFIT_TARGET_AUD / 1_000_000).toFixed(0)}M`} color={CHART_COLORS.amber} positive />
        </div>
      )}

      {/* Grouped bars: profit per entity per month */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Net profit by entity</h2>
          <Legend items={[{ label: "SC", color: CHART_COLORS.cyan }, { label: "CQ", color: CHART_COLORS.indigo }]} />
        </div>
        <BarSvg chart={bars} />
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Faded months bill in arrears and are under-booked on income — they look like a loss until
          invoicing catches up. Read the solid bars as real.
        </p>
      </div>

      {/* Consolidated trend line */}
      <div className="card">
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Combined net profit trend</h2>
        <LineSvg chart={line} />
      </div>
    </main>
  );
}

// ── presentational helpers (server components, inline) ──────────────────────

function Kpi({ label, value, color, positive }: { label: string; value: string; color: string; positive: boolean }) {
  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: positive ? color : CHART_COLORS.rose, fontFamily: "var(--font-mono)" }}>
        {value}
      </div>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 14 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-muted)" }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: "inline-block" }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function BarSvg({ chart }: { chart: ReturnType<typeof groupedBars> }) {
  return (
    <svg viewBox={`0 0 ${chart.width} ${chart.height}`} width="100%" role="img" aria-label="Net profit by entity, grouped bars">
      {/* gridlines + y labels */}
      {chart.ticks.map((t, i) => (
        <g key={i}>
          <line x1={chart.padL} x2={chart.width - chart.padR} y1={t.y} y2={t.y} stroke={CHART_COLORS.grid} strokeWidth={1} />
          <text x={chart.padL - 8} y={t.y + 4} textAnchor="end" fontSize={11} fill={CHART_COLORS.muted} fontFamily="var(--font-mono)">{t.label}</text>
        </g>
      ))}
      {/* zero baseline emphasised */}
      <line x1={chart.padL} x2={chart.width - chart.padR} y1={chart.zeroY} y2={chart.zeroY} stroke={CHART_COLORS.muted} strokeWidth={1.2} />
      {/* bars */}
      {chart.bars.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={2} fill={b.color} opacity={b.faded ? 0.32 : 0.92} />
      ))}
      {/* category labels */}
      {chart.catLabels.map((c, i) => (
        <text key={i} x={c.x} y={chart.height - 22} textAnchor="middle" fontSize={12} fill={c.faded ? CHART_COLORS.muted : CHART_COLORS.fg} fontFamily="var(--font-mono)">{c.label}</text>
      ))}
    </svg>
  );
}

function LineSvg({ chart }: { chart: ReturnType<typeof lineChart> }) {
  return (
    <svg viewBox={`0 0 ${chart.width} ${chart.height}`} width="100%" role="img" aria-label="Combined net profit trend line">
      {chart.ticks.map((t, i) => (
        <g key={i}>
          <line x1={chart.padL} x2={chart.width - chart.padR} y1={t.y} y2={t.y} stroke={CHART_COLORS.grid} strokeWidth={1} />
          <text x={chart.padL - 8} y={t.y + 4} textAnchor="end" fontSize={11} fill={CHART_COLORS.muted} fontFamily="var(--font-mono)">{t.label}</text>
        </g>
      ))}
      <line x1={chart.padL} x2={chart.width - chart.padR} y1={chart.zeroY} y2={chart.zeroY} stroke={CHART_COLORS.muted} strokeWidth={1.2} />
      <polyline points={chart.polyline} fill="none" stroke={chart.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {chart.points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={4} fill={p.faded ? "var(--bg-card)" : chart.color} stroke={chart.color} strokeWidth={2} opacity={p.faded ? 0.5 : 1} />
      ))}
      {chart.catLabels.map((c, i) => (
        <text key={i} x={c.x} y={chart.height - 22} textAnchor="middle" fontSize={12} fill={c.faded ? CHART_COLORS.muted : CHART_COLORS.fg} fontFamily="var(--font-mono)">{c.label}</text>
      ))}
    </svg>
  );
}
