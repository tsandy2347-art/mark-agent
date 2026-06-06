// /reports/revenue?entity=sc|cq|both — Mark's revenue dashboard.
//
// Top of page: SC / CQ / Both toggle. Mark can flip it on a call by emitting
// [SCREEN: revenue?entity=cq] etc.
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

// Hard-coded palette — the project's CSS vars (--cyan / --green / --bg-elev)
// don't exist, so var() lookups fell back to "currentColor" which rendered as
// near-black on the dark theme. These hexes match the project's --accent etc.
const C = {
  now: "#22d3ee",        // cyan — this month
  prev: "#a78bfa",        // violet — last month (more contrast than indigo)
  yoy: "#34d399",         // emerald — same month last year
  pos: "#34d399",         // emerald for up
  neg: "#f43f5e",         // rose for down
  flat: "#8a96ac",        // muted for ~0
  fg: "#e8eef7",
  fgStrong: "#ffffff",
  fgMuted: "#8a96ac",
  fgDim: "#5a6478",
  cardBg: "#0f1623",
  cardElev: "#131c2c",
  border: "#1f2937",
  borderStrong: "#2a3447",
};

function parseEntity(raw: string | string[] | undefined): EntityKey {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
  if (v === "sc" || v === "cq") return v;
  return "both";
}

// Compact dollar format — "$1.94M", "$157k", "$3,038".
// Used for chart-on-bar labels and the tight per-stream card heading.
function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs).toLocaleString("en-AU")}`;
}

// Full-precision dollar format — used for the big headline KPIs only.
function fmtFull(n: number): string {
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
  if (abs > 0) return C.pos;
  if (abs < 0) return C.neg;
  return C.flat;
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

  const yMax = Math.max(...streamRows.flatMap((r) => [r.now, r.prev, r.yoy]), 1);
  const prevLabel = prev ? monthShortYr(prev.month) : "Last month";
  const yoyLabel = yoy ? monthShortYr(yoy.month) : "YoY";
  const nowLabel = monthShortYr(asOf.month);

  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 22, fontWeight: 700, letterSpacing: -0.2 }}>
        {entity}
        <span style={{ fontSize: 13, fontWeight: 400, marginLeft: 12, color: C.fgMuted }}>
          {asOfLabel}
        </span>
      </h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <KpiCard label="Total revenue" value={fmtFull(total)} accent={C.now} />
        <DeltaKpi label="vs last month" delta={dPrev.abs} pct={dPrev.pct} base={prevTotal} />
        <DeltaKpi label="vs same month last year" delta={dYoy.abs} pct={dYoy.pct} base={yoyTotal} />
      </div>

      <div style={{
        marginTop: 16,
        padding: 18,
        background: C.cardBg,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2, color: C.fgMuted }}>
            By income stream — 3-month comparison
          </h3>
          <div style={{ display: "flex", gap: 16, fontSize: 11.5, color: C.fgMuted }}>
            <LegendDot color={C.now} label={`${nowLabel} (this)`} />
            <LegendDot color={C.prev} label={`${prevLabel} (last)`} />
            <LegendDot color={C.yoy} label={`${yoyLabel} (YoY)`} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12, marginTop: 14 }}>
          {streamRows.map((r) => (
            <StreamCard
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
    </section>
  );
}

function StreamCard({
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
  const W = 260;
  const H = 150;
  const padL = 10;
  const padR = 10;
  const padT = 22;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const slot = innerW / 3;
  const barW = slot * 0.66;

  function bar(value: number, idx: number, color: string, label: string) {
    const h = yMax > 0 ? (value / yMax) * innerH : 0;
    const x = padL + slot * idx + (slot - barW) / 2;
    const y = padT + innerH - h;
    return (
      <g key={idx}>
        <rect x={x} y={y} width={barW} height={Math.max(h, 1)} fill={color} rx={3} />
        {value > 0 && (
          <text
            x={x + barW / 2}
            y={y - 5}
            fontSize="10.5"
            fontWeight="600"
            fill={C.fgStrong}
            textAnchor="middle"
          >
            {fmtCompact(value)}
          </text>
        )}
        <text
          x={x + barW / 2}
          y={padT + innerH + 14}
          fontSize="10"
          fill={C.fgMuted}
          textAnchor="middle"
        >
          {label}
        </text>
      </g>
    );
  }

  const dp = pctDelta(now, prev);
  const dy = pctDelta(now, yoy);

  return (
    <div style={{
      background: C.cardElev,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "12px 14px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.fgStrong, letterSpacing: 0.2 }}>
          {stream}
        </span>
        <span style={{ fontSize: 16, fontWeight: 700, color: C.fgStrong, fontVariantNumeric: "tabular-nums" }}>
          {fmtCompact(now)}
        </span>
      </div>
      <div style={{ fontSize: 11.5, marginBottom: 8, color: C.fgMuted, display: "flex", gap: 10 }}>
        <span>
          <span style={{ color: deltaColor(dp.abs), fontWeight: 600 }}>
            {deltaArrow(dp.abs)} {fmtPct(dp.pct)}
          </span>
          <span style={{ color: C.fgDim }}> last</span>
        </span>
        <span>
          <span style={{ color: deltaColor(dy.abs), fontWeight: 600 }}>
            {deltaArrow(dy.abs)} {fmtPct(dy.pct)}
          </span>
          <span style={{ color: C.fgDim }}> YoY</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: "auto" }}>
        {bar(now, 0, C.now, nowLabel)}
        {bar(prev, 1, C.prev, prevLabel)}
        {bar(yoy, 2, C.yoy, yoyLabel)}
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
    <section style={{
      marginTop: 28,
      padding: 18,
      background: C.cardBg,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      borderTop: `2px solid ${C.now}`,
    }}>
      <h3 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2, color: C.fgMuted }}>
        Combined · SC + CQ · {asOfLabel}
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 }}>
        <KpiCard label="Total" value={fmtFull(total)} accent={C.now} />
        <DeltaKpi label="vs last month" delta={dp.abs} pct={dp.pct} base={prev} />
        <DeltaKpi label="vs same month last year" delta={dy.abs} pct={dy.pct} base={yoy} />
      </div>
    </section>
  );
}

function Toggle({ active }: { active: EntityKey }) {
  const opts: { key: EntityKey; label: string }[] = [
    { key: "sc", label: "SC" },
    { key: "cq", label: "CQ" },
    { key: "both", label: "Both" },
  ];
  return (
    <div style={{
      display: "inline-flex",
      gap: 4,
      padding: 4,
      background: C.cardElev,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
    }}>
      {opts.map((o) => {
        const on = o.key === active;
        return (
          <Link
            key={o.key}
            href={`/reports/revenue?entity=${o.key}`}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
              background: on ? C.now : "transparent",
              color: on ? "#06121a" : C.fgMuted,
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
        <span style={{ fontSize: 12, color: C.fgMuted, fontFamily: "var(--font-mono)" }}>
          Last fully-settled · {data.asOfLabel}
        </span>
      </div>
      <p style={{ marginTop: 4, fontSize: 12, color: C.fgMuted }}>
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

function KpiCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{
      padding: 16,
      background: C.cardBg,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.4, color: C.fgMuted }}>
        {label}
      </div>
      <div style={{
        fontSize: 28,
        fontWeight: 700,
        color: accent,
        marginTop: 6,
        letterSpacing: -0.5,
        fontVariantNumeric: "tabular-nums",
      }}>
        {value}
      </div>
    </div>
  );
}

function DeltaKpi({ label, delta, pct, base }: { label: string; delta: number; pct: number | null; base: number }) {
  const color = deltaColor(delta);
  return (
    <div style={{
      padding: 16,
      background: C.cardBg,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.4, color: C.fgMuted }}>
        {label}
      </div>
      <div style={{
        fontSize: 22,
        fontWeight: 700,
        color,
        marginTop: 6,
        letterSpacing: -0.3,
        fontVariantNumeric: "tabular-nums",
        display: "flex",
        alignItems: "baseline",
        gap: 8,
      }}>
        <span>{deltaArrow(delta)} {fmtFull(Math.abs(delta))}</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>({fmtPct(pct)})</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.fgDim, marginTop: 4 }}>
        was {fmtFull(base)}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ display: "inline-block", width: 11, height: 11, background: color, borderRadius: 2 }} />
      {label}
    </span>
  );
}
