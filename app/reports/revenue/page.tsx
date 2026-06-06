// /reports/revenue?entity=sc|cq|both — Mark's revenue dashboard.
//
// Top of page: SC / CQ / Both toggle. Mark can flip it on a call by
// emitting [SCREEN: revenue?entity=cq] etc.
//
// For each visible entity: KPI cards, then a bar chart per stream with three
// bars side-by-side — this month / last month / same month last year.
//
// Bottom of page: combined-totals strip (SC + CQ) for the as-of month.

import Link from "next/link";
import {
  loadRevenueSummary,
  pctDelta,
  STREAMS,
  type Stream,
} from "@/lib/mark/revenue";

export const dynamic = "force-dynamic";

type EntityKey = "sc" | "cq" | "both";

function parseEntity(raw: string | string[] | undefined): EntityKey {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
  if (v === "sc" || v === "cq") return v;
  return "both";
}

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

function monthShortYr(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-AU", { month: "short", year: "2-digit" });
}

interface EntityView {
  entity: "SC" | "CQ";
  asOf: { month: string; total: number; byStream: Record<Stream | "Other", number> };
  prev?: { month: string; total: number; byStream: Record<Stream | "Other", number> };
  yoy?: { month: string; total: number; byStream: Record<Stream | "Other", number> };
  asOfLabel: string;
}

function EntityBlock({ entity, asOf, prev, yoy, asOfLabel }: EntityView) {
  const total = asOf.total;
  const prevTotal = prev?.total ?? 0;
  const yoyTotal = yoy?.total ?? 0;
  const dPrev = pctDelta(total, prevTotal);
  const dYoy = pctDelta(total, yoyTotal);

  // Streams used by this entity, sorted by this-month size.
  const streamRows = (STREAMS as readonly Stream[])
    .map((s) => ({
      stream: s,
      now: asOf.byStream[s] ?? 0,
      prev: prev?.byStream[s] ?? 0,
      yoy: yoy?.byStream[s] ?? 0,
    }))
    .filter((r) => r.now > 0 || r.prev > 0 || r.yoy > 0)
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

  // Chart scale — single y-axis across all streams for this entity so the
  // bars are comparable at a glance.
  const yMax = Math.max(
    ...streamRows.flatMap((r) => [r.now, r.prev, r.yoy]),
    1,
  );

  const prevLabel = prev ? monthShortYr(prev.month) : "Last month";
  const yoyLabel = yoy ? monthShortYr(yoy.month) : "YoY";
  const nowLabel = monthShortYr(asOf.month);

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ margin: "0 0 10px", fontSize: 20 }}>
        {entity}
        <span className="muted" style={{ fontSize: 13, fontWeight: 400, marginLeft: 10 }}>
          {asOfLabel}
        </span>
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

      {/* Per-stream bar chart */}
      <div className="card" style={{ marginTop: 14, padding: 16 }}>
        <h3 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)" }}>
          By income stream — three-month comparison
        </h3>
        <div style={{ display: "flex", gap: 18, fontSize: 12, color: "var(--fg-muted)", marginTop: 8, marginBottom: 12 }}>
          <LegendDot color="var(--cyan)" label={`${nowLabel} (this)`} />
          <LegendDot color="var(--indigo)" label={`${prevLabel} (last)`} />
          <LegendDot color="var(--emerald)" label={`${yoyLabel} (YoY)`} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          {streamRows.map((r) => (
            <StreamBars
              key={r.stream}
              stream={r.stream}
              now={r.now}
              prev={r.prev}
              yoy={r.yoy}
              yMax={yMax}
              nowLabel={nowLabel}
              prevLabel={prevLabel}
              yoyLabel={yoyLabel}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function StreamBars({
  stream, now, prev, yoy, yMax, nowLabel, prevLabel, yoyLabel,
}: {
  stream: string;
  now: number;
  prev: number;
  yoy: number;
  yMax: number;
  nowLabel: string;
  prevLabel: string;
  yoyLabel: string;
}) {
  // SVG: three vertical bars, labels under, value tags on top of each bar.
  const W = 220;
  const H = 140;
  const padL = 8;
  const padR = 8;
  const padT = 24;
  const padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const slot = innerW / 3;
  const barW = slot * 0.62;

  function bar(value: number, idx: number, color: string, label: string) {
    const h = yMax > 0 ? (value / yMax) * innerH : 0;
    const x = padL + slot * idx + (slot - barW) / 2;
    const y = padT + innerH - h;
    return (
      <g key={idx}>
        <rect x={x} y={y} width={barW} height={Math.max(h, 1)} fill={color} rx={2} />
        {value > 0 && (
          <text x={x + barW / 2} y={y - 4} fontSize="10" fill="var(--fg)" textAnchor="middle">
            {fmtAmount(value)}
          </text>
        )}
        <text x={x + barW / 2} y={padT + innerH + 14} fontSize="10" fill="#8a96ac" textAnchor="middle">
          {label}
        </text>
      </g>
    );
  }

  // Delta caption under the title — vs last month, vs YoY.
  const dp = pctDelta(now, prev);
  const dy = pctDelta(now, yoy);

  return (
    <div style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <strong style={{ fontSize: 13 }}>{stream}</strong>
        <span className="mono" style={{ fontSize: 12, color: "var(--fg)" }}>{fmtAmount(now)}</span>
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
        <span style={{ color: deltaColor(dp.abs) }}>{deltaArrow(dp.abs)} {fmtPct(dp.pct)}</span>
        <span> vs last · </span>
        <span style={{ color: deltaColor(dy.abs) }}>{deltaArrow(dy.abs)} {fmtPct(dy.pct)}</span>
        <span> YoY</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: "auto" }}>
        {bar(now, 0, "var(--cyan)", nowLabel)}
        {bar(prev, 1, "var(--indigo)", prevLabel)}
        {bar(yoy, 2, "var(--emerald)", yoyLabel)}
      </svg>
    </div>
  );
}

function CombinedFooter({
  scAsOf, cqAsOf, scPrev, cqPrev, scYoy, cqYoy, asOfLabel,
}: {
  scAsOf: { total: number };
  cqAsOf: { total: number };
  scPrev?: { total: number };
  cqPrev?: { total: number };
  scYoy?: { total: number };
  cqYoy?: { total: number };
  asOfLabel: string;
}) {
  const total = scAsOf.total + cqAsOf.total;
  const prev = (scPrev?.total ?? 0) + (cqPrev?.total ?? 0);
  const yoy = (scYoy?.total ?? 0) + (cqYoy?.total ?? 0);
  const dp = pctDelta(total, prev);
  const dy = pctDelta(total, yoy);
  return (
    <div className="card" style={{ marginTop: 24, padding: 16, borderTop: "2px solid var(--cyan)" }}>
      <h3 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)" }}>
        Combined · SC + CQ · {asOfLabel}
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 10 }}>
        <KpiCard label="Total" value={total} color="var(--cyan)" />
        <KpiCard
          label="vs last month"
          value={dp.abs}
          sub={`${fmtPct(dp.pct)} · was ${fmtAmount(prev)}`}
          color={deltaColor(dp.abs)}
          arrow={deltaArrow(dp.abs)}
        />
        <KpiCard
          label="vs same month last year"
          value={dy.abs}
          sub={`${fmtPct(dy.pct)} · was ${fmtAmount(yoy)}`}
          color={deltaColor(dy.abs)}
          arrow={deltaArrow(dy.abs)}
        />
      </div>
    </div>
  );
}

function Toggle({ active }: { active: EntityKey }) {
  const opts: { key: EntityKey; label: string }[] = [
    { key: "sc", label: "SC" },
    { key: "cq", label: "CQ" },
    { key: "both", label: "Both" },
  ];
  return (
    <div style={{ display: "inline-flex", gap: 4, padding: 4, background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8 }}>
      {opts.map((o) => {
        const on = o.key === active;
        return (
          <Link
            key={o.key}
            href={`/reports/revenue?entity=${o.key}`}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
              background: on ? "var(--cyan)" : "transparent",
              color: on ? "var(--bg)" : "var(--fg-muted)",
            }}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

export default async function RevenueReportPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string | string[] }>;
}) {
  const sp = await searchParams;
  const active = parseEntity(sp.entity);
  const data = await loadRevenueSummary();

  const sc = data.entities.find((e) => e.entity === "SC")!;
  const cq = data.entities.find((e) => e.entity === "CQ")!;

  const showSc = active === "sc" || active === "both";
  const showCq = active === "cq" || active === "both";

  return (
    <main className="container">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <h1 style={{ margin: 0 }}>Revenue</h1>
          <Toggle active={active} />
        </div>
        <span className="muted mono" style={{ fontSize: 12 }}>
          Last fully-settled · {data.asOfLabel}
        </span>
      </div>
      <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
        Arrears rule: month X only counts after the 20th of the next month.
        Toggle the view between SC, CQ, or Both — Mark can flick this on a call.
      </p>

      {showSc && (
        <EntityBlock
          entity="SC"
          asOf={sc.asOf}
          prev={sc.prevMonth}
          yoy={sc.yoyMonth}
          asOfLabel={data.asOfLabel}
        />
      )}
      {showCq && (
        <EntityBlock
          entity="CQ"
          asOf={cq.asOf}
          prev={cq.prevMonth}
          yoy={cq.yoyMonth}
          asOfLabel={data.asOfLabel}
        />
      )}

      <CombinedFooter
        scAsOf={sc.asOf}
        cqAsOf={cq.asOf}
        scPrev={sc.prevMonth}
        cqPrev={cq.prevMonth}
        scYoy={sc.yoyMonth}
        cqYoy={cq.yoyMonth}
        asOfLabel={data.asOfLabel}
      />
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

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span>
      <span style={{ display: "inline-block", width: 10, height: 10, background: color, marginRight: 6, verticalAlign: "middle", borderRadius: 2 }} />
      {label}
    </span>
  );
}
