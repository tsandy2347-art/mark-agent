// /reports/revenue — Mark's revenue dashboard.
//
// Reads the stored MonthlyFinancials table (no live Xero hit, no token cost).
// Shows the LAST FULLY-SETTLED month, broken down by income stream, vs the
// previous month and the same month last year. Per-entity table sits
// underneath so Tony can see SC vs CQ at a glance.
//
// "Last fully-settled" follows Tony's rule: current month only counts AFTER
// the 20th; otherwise show last month. May 2026 won't appear until 20 June.

import {
  loadRevenueSummary,
  pctDelta,
  STREAMS,
  type Stream,
} from "@/lib/mark/revenue";
import { CHART_COLORS, groupedBars } from "@/lib/charts";

export const dynamic = "force-dynamic";

function fmtAmount(n: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtPct(p: number | null): string {
  if (p === null) return "—";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

function deltaColor(abs: number): string {
  if (abs > 0) return "var(--green)";
  if (abs < 0) return "var(--rose)";
  return "var(--fg-muted)";
}

function deltaArrow(abs: number): string {
  if (abs > 0) return "▲";
  if (abs < 0) return "▼";
  return "→";
}

function monthShort(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-AU", { month: "short" });
}

export default async function RevenueReportPage() {
  const data = await loadRevenueSummary();

  if (data.asOf.total === 0) {
    return (
      <main className="container">
        <h1>Revenue</h1>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No revenue stored for {data.asOfLabel}. Upload the Xero P&amp;L on
            the Profit history page to populate.
          </p>
        </div>
      </main>
    );
  }

  const total = data.asOf.total;
  const prevTotal = data.prevMonth?.total ?? 0;
  const yoyTotal = data.yoyMonth?.total ?? 0;
  const dPrev = pctDelta(total, prevTotal);
  const dYoy = pctDelta(total, yoyTotal);

  // Chart: stacked-equivalent grouped bars across the last 13 months for the
  // top-three streams (NDIA, SAH, SIL). Keeps the chart legible. The full
  // breakdown is in the table below.
  const chartStreams: Stream[] = ["NDIA", "SAH", "SIL"];
  const chart = groupedBars({
    categories: data.monthly.map((m) => monthShort(m.month)),
    series: chartStreams.map((s, idx) => ({
      label: s,
      color: [CHART_COLORS.cyan, CHART_COLORS.indigo, CHART_COLORS.emerald][idx],
      values: data.monthly.map((m) => m.byStream[s]),
    })),
    width: 780,
    height: 220,
  });

  // Stream rows for the breakdown table — sorted by current-month size.
  const streamRows = (STREAMS as readonly Stream[])
    .map((s) => {
      const now = data.asOf.byStream[s] ?? 0;
      const prev = data.prevMonth?.byStream[s] ?? 0;
      const yoy = data.yoyMonth?.byStream[s] ?? 0;
      return { stream: s, now, prev, yoy };
    })
    .sort((a, b) => b.now - a.now);
  const otherNow = data.asOf.byStream.Other ?? 0;
  if (otherNow > 0) {
    streamRows.push({
      stream: "Other" as Stream,
      now: otherNow,
      prev: data.prevMonth?.byStream.Other ?? 0,
      yoy: data.yoyMonth?.byStream.Other ?? 0,
    });
  }

  return (
    <main className="container">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Revenue</h1>
        <span className="muted mono" style={{ fontSize: 12 }}>
          Last fully-settled month · {data.asOfLabel}
        </span>
      </div>
      <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
        Following Tony&apos;s rule: only count the current month once we&apos;re past the 20th.
        Otherwise the most recent month is still settling and reads as a false drop.
      </p>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 14 }}>
        <KpiCard
          label={`Revenue · ${data.asOfLabel}`}
          value={total}
          color="var(--cyan)"
        />
        <KpiCard
          label="vs last month"
          value={dPrev.abs}
          sub={`${fmtPct(dPrev.pct)} · was ${fmtAmount(prevTotal)}`}
          color={deltaColor(dPrev.abs)}
          arrow={deltaArrow(dPrev.abs)}
        />
        <KpiCard
          label="vs same month last year"
          value={dYoy.abs}
          sub={`${fmtPct(dYoy.pct)} · was ${fmtAmount(yoyTotal)}`}
          color={deltaColor(dYoy.abs)}
          arrow={deltaArrow(dYoy.abs)}
        />
      </div>

      {/* Per-stream table */}
      <div className="card" style={{ marginTop: 18, padding: 0, overflow: "hidden" }}>
        <h2 style={{ margin: 0, padding: "12px 16px", fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)", borderBottom: "1px solid var(--border)" }}>
          By income stream
        </h2>
        <table>
          <thead>
            <tr>
              <th>Stream</th>
              <th style={{ textAlign: "right" }}>{data.asOfLabel}</th>
              <th style={{ textAlign: "right" }}>Last month</th>
              <th style={{ textAlign: "right" }}>Δ vs last</th>
              <th style={{ textAlign: "right" }}>YoY same month</th>
              <th style={{ textAlign: "right" }}>Δ YoY</th>
            </tr>
          </thead>
          <tbody>
            {streamRows.map((r) => {
              const dp = pctDelta(r.now, r.prev);
              const dy = pctDelta(r.now, r.yoy);
              return (
                <tr key={r.stream}>
                  <td className="mono" style={{ fontSize: 13 }}>{r.stream}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtAmount(r.now)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--fg-muted)", fontSize: 12 }}>{fmtAmount(r.prev)}</td>
                  <td className="mono" style={{ textAlign: "right", color: deltaColor(dp.abs), fontSize: 12 }}>
                    {deltaArrow(dp.abs)} {fmtPct(dp.pct)}
                  </td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--fg-muted)", fontSize: 12 }}>{fmtAmount(r.yoy)}</td>
                  <td className="mono" style={{ textAlign: "right", color: deltaColor(dy.abs), fontSize: 12 }}>
                    {deltaArrow(dy.abs)} {fmtPct(dy.pct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Per-entity */}
      <div className="card" style={{ marginTop: 18, padding: 0, overflow: "hidden" }}>
        <h2 style={{ margin: 0, padding: "12px 16px", fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)", borderBottom: "1px solid var(--border)" }}>
          By entity · {data.asOfLabel}
        </h2>
        <table>
          <thead>
            <tr>
              <th>Entity</th>
              <th style={{ textAlign: "right" }}>Total</th>
              {(STREAMS as readonly string[]).map((s) => (
                <th key={s} style={{ textAlign: "right", fontSize: 11 }}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.entityMostRecent.map((e) => (
              <tr key={e.entity}>
                <td className="mono" style={{ fontSize: 13 }}>{e.entity}</td>
                <td className="mono" style={{ textAlign: "right" }}>{fmtAmount(e.total)}</td>
                {(STREAMS as readonly Stream[]).map((s) => (
                  <td key={s} className="mono" style={{ textAlign: "right", fontSize: 12, color: e.byStream[s] === 0 ? "var(--fg-muted)" : undefined }}>
                    {e.byStream[s] === 0 ? "—" : fmtAmount(e.byStream[s])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 13-month trend chart */}
      <div className="card" style={{ marginTop: 18, padding: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)" }}>
          Trend · top three streams · last 13 months
        </h2>
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} style={{ display: "block", maxWidth: "100%", height: "auto", marginTop: 8 }}>
          {chart.bars.map((b, i) => (
            <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.color} opacity={b.faded ? 0.3 : 1} />
          ))}
          {chart.catLabels.map((l, i) => (
            <text key={i} x={l.x} y={chart.height - chart.padB + 18} fontSize="11" fill="#8a96ac" textAnchor="middle">{l.label}</text>
          ))}
          {chart.ticks.map((t, i) => (
            <text key={i} x={chart.padL - 6} y={t.y + 3} fontSize="10" fill="#5a6478" textAnchor="end">{t.label}</text>
          ))}
        </svg>
        <div style={{ display: "flex", gap: 18, fontSize: 12, color: "var(--fg-muted)", marginTop: 8 }}>
          {chartStreams.map((s, i) => (
            <span key={s}>
              <span style={{ display: "inline-block", width: 10, height: 10, background: [CHART_COLORS.cyan, CHART_COLORS.indigo, CHART_COLORS.emerald][i], marginRight: 6, verticalAlign: "middle" }} />
              {s}
            </span>
          ))}
        </div>
      </div>
    </main>
  );
}

function KpiCard({ label, value, sub, color, arrow }: { label: string; value: number; sub?: string; color: string; arrow?: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, marginTop: 4 }}>
        {arrow ? <span style={{ marginRight: 6 }}>{arrow}</span> : null}{fmtAmount(value)}
      </div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
