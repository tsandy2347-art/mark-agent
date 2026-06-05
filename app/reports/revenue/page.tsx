// /reports/revenue — Mark's revenue dashboard, SC and CQ side-by-side.
//
// Reads stored MonthlyFinancials. NO combined view — per Tony, combined is
// useless given how different the two entities are. Each entity has its own
// KPI cards, per-stream breakdown, trend chart, and deltas vs last month +
// same month last year.

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

interface EntityBlockProps {
  entity: "SC" | "CQ";
  monthly: { month: string; total: number; byStream: Record<Stream | "Other", number> }[];
  asOf: { month: string; total: number; byStream: Record<Stream | "Other", number> };
  prev?: { month: string; total: number; byStream: Record<Stream | "Other", number> };
  yoy?: { month: string; total: number; byStream: Record<Stream | "Other", number> };
  asOfLabel: string;
}

function EntityBlock({ entity, monthly, asOf, prev, yoy, asOfLabel }: EntityBlockProps) {
  const total = asOf.total;
  const prevTotal = prev?.total ?? 0;
  const yoyTotal = yoy?.total ?? 0;
  const dPrev = pctDelta(total, prevTotal);
  const dYoy = pctDelta(total, yoyTotal);

  // Streams in order of size in the as-of month.
  const streamRows = (STREAMS as readonly Stream[])
    .map((s) => ({
      stream: s,
      now: asOf.byStream[s] ?? 0,
      prev: prev?.byStream[s] ?? 0,
      yoy: yoy?.byStream[s] ?? 0,
    }))
    .filter((r) => r.now > 0 || r.prev > 0 || r.yoy > 0) // hide streams this entity has never used
    .sort((a, b) => b.now - a.now);
  const otherNow = asOf.byStream.Other ?? 0;
  if (otherNow > 0 || (prev?.byStream.Other ?? 0) > 0 || (yoy?.byStream.Other ?? 0) > 0) {
    streamRows.push({
      stream: "Other" as Stream,
      now: otherNow,
      prev: prev?.byStream.Other ?? 0,
      yoy: yoy?.byStream.Other ?? 0,
    });
  }

  // Trend chart: this entity's top three streams by current-month size.
  const topStreams = streamRows.slice(0, 3).map((r) => r.stream);
  const chart = groupedBars({
    categories: monthly.map((m) => monthShort(m.month)),
    series: topStreams.map((s, idx) => ({
      label: s,
      color: [CHART_COLORS.cyan, CHART_COLORS.indigo, CHART_COLORS.emerald][idx],
      values: monthly.map((m) => m.byStream[s as Stream] ?? 0),
    })),
    width: 720,
    height: 200,
  });

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ margin: "0 0 10px", fontSize: 18 }}>
        {entity} <span className="muted" style={{ fontSize: 13, fontWeight: 400, marginLeft: 8 }}>{asOfLabel}</span>
      </h2>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <KpiCard label="Total revenue" value={total} color="var(--cyan)" />
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

      {/* Per-stream */}
      <div className="card" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
        <h3 style={{ margin: 0, padding: "10px 16px", fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)", borderBottom: "1px solid var(--border)" }}>
          By income stream
        </h3>
        <table>
          <thead>
            <tr>
              <th>Stream</th>
              <th style={{ textAlign: "right" }}>{asOfLabel}</th>
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
                  <td className="mono" style={{ textAlign: "right" }}>{r.now === 0 ? "—" : fmtAmount(r.now)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--fg-muted)", fontSize: 12 }}>{r.prev === 0 ? "—" : fmtAmount(r.prev)}</td>
                  <td className="mono" style={{ textAlign: "right", color: deltaColor(dp.abs), fontSize: 12 }}>
                    {r.prev === 0 && r.now === 0 ? "—" : `${deltaArrow(dp.abs)} ${fmtPct(dp.pct)}`}
                  </td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--fg-muted)", fontSize: 12 }}>{r.yoy === 0 ? "—" : fmtAmount(r.yoy)}</td>
                  <td className="mono" style={{ textAlign: "right", color: deltaColor(dy.abs), fontSize: 12 }}>
                    {r.yoy === 0 && r.now === 0 ? "—" : `${deltaArrow(dy.abs)} ${fmtPct(dy.pct)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Trend chart */}
      {topStreams.length > 0 && (
        <div className="card" style={{ marginTop: 14, padding: 16 }}>
          <h3 style={{ marginTop: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)" }}>
            Trend · top streams · last 13 months
          </h3>
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
            {topStreams.map((s, i) => (
              <span key={s}>
                <span style={{ display: "inline-block", width: 10, height: 10, background: [CHART_COLORS.cyan, CHART_COLORS.indigo, CHART_COLORS.emerald][i], marginRight: 6, verticalAlign: "middle" }} />
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default async function RevenueReportPage() {
  const data = await loadRevenueSummary();

  return (
    <main className="container">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Revenue</h1>
        <span className="muted mono" style={{ fontSize: 12 }}>
          Last fully-settled month · {data.asOfLabel}
        </span>
      </div>
      <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
        Per entity — combined view intentionally excluded.
        Tony&apos;s arrears rule: month X only counts after the 20th of the following month
        (so May won&apos;t show until 20 June).
      </p>

      {data.entities.map((e) => (
        <EntityBlock
          key={e.entity}
          entity={e.entity}
          monthly={e.monthly}
          asOf={e.asOf}
          prev={e.prevMonth}
          yoy={e.yoyMonth}
          asOfLabel={data.asOfLabel}
        />
      ))}
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
