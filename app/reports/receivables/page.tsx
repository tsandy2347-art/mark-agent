// /reports/receivables — Mark's aged AR dashboard.
//
// Reads directly from Monty's findings in the shared DB (no live Xero hit on
// page render). The page is server-rendered so the screen-pop iframe paints
// instantly — same pattern as /reports/profit.
//
// What's on it:
//   - "As of" timestamp (when Monty last ran)
//   - Four KPI cards: total open, 60+, 90+, 120+ writeoff candidates
//   - Per-entity bucket bars (SC vs CQ × age bucket)
//   - Top 10 debtors by outstanding $, each linked to its drill-in page
//
// Drill-in: /reports/receivables/[xeroContactId] shows every overdue invoice
// for that debtor (built in the same commit).

import Link from "next/link";
import { brisbane } from "@/lib/time";
import { loadReceivablesSummary, type BucketRow } from "@/lib/mark/receivables";
import { CHART_COLORS, groupedBars } from "@/lib/charts";

export const dynamic = "force-dynamic";

function fmtAmount(n: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

function ageBadge(ageDays: number): { color: string; label: string } {
  if (ageDays >= 120) return { color: "var(--rose)", label: "writeoff" };
  if (ageDays >= 90) return { color: "var(--rose)", label: "90+ days" };
  if (ageDays >= 60) return { color: "var(--amber)", label: "60+ days" };
  if (ageDays >= 30) return { color: "var(--amber)", label: "30+ days" };
  return { color: "var(--fg-muted)", label: `${ageDays}d` };
}

export default async function ReceivablesReportPage() {
  const summary = await loadReceivablesSummary(10);

  if (!summary.asOf) {
    return (
      <main className="container">
        <h1>Accounts receivable</h1>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Monty hasn&apos;t completed a run yet — no receivables data on file. Try
            again after his next nightly sweep.
          </p>
        </div>
      </main>
    );
  }

  // Build a grouped-bar chart from the bucket data — one bar per (entity,
  // bucket) so the eye can quickly compare SC vs CQ at each age.
  const BUCKET_ORDER: BucketRow["bucket"][] = ["31-60", "61-90", "90+"];
  const seriesSC = BUCKET_ORDER.map((b) =>
    summary.buckets
      .filter((x) => x.entity === "SC" && x.bucket === b)
      .reduce((s, x) => s + x.outstanding, 0),
  );
  const seriesCQ = BUCKET_ORDER.map((b) =>
    summary.buckets
      .filter((x) => x.entity === "CQ" && x.bucket === b)
      .reduce((s, x) => s + x.outstanding, 0),
  );
  const chart = groupedBars({
    categories: BUCKET_ORDER,
    series: [
      { label: "SC", color: CHART_COLORS.cyan, values: seriesSC },
      { label: "CQ", color: CHART_COLORS.indigo, values: seriesCQ },
    ],
    width: 720,
    height: 220,
  });

  return (
    <main className="container">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Accounts receivable</h1>
        <span className="muted mono" style={{ fontSize: 12 }}>
          As of Monty&apos;s last run · {brisbane(summary.asOf)}
        </span>
      </div>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 16 }}>
        <KpiCard label="60+ days overdue" value={summary.total60Plus} sub={`${summary.totalOpenInvoices} invoices flagged`} color="var(--amber)" />
        <KpiCard label="90+ days overdue" value={summary.total90Plus} color="var(--rose)" />
        <KpiCard label="120+ days (writeoff)" value={summary.total120Plus} color="var(--rose)" />
        <KpiCard label="Exposure breaches" value={summary.exposureBreachTotal} sub={`${summary.exposureBreachCount} debtors over limit`} color="var(--rose)" />
      </div>

      {/* Chart */}
      <div className="card" style={{ marginTop: 18, padding: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)" }}>
          Outstanding by age, SC vs CQ
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
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: CHART_COLORS.cyan, marginRight: 6, verticalAlign: "middle" }} />SC</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: CHART_COLORS.indigo, marginRight: 6, verticalAlign: "middle" }} />CQ</span>
        </div>
      </div>

      {/* Top debtors */}
      <div className="card" style={{ marginTop: 18, padding: 0, overflow: "hidden" }}>
        <h2 style={{ margin: 0, padding: "12px 16px", fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-muted)", borderBottom: "1px solid var(--border)" }}>
          Top 10 debtors by outstanding $
        </h2>
        {summary.topDebtors.length === 0 ? (
          <p className="muted" style={{ padding: 16, margin: 0 }}>No overdue debtors on Monty&apos;s latest run.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Debtor</th>
                <th>Entity</th>
                <th style={{ textAlign: "right" }}>Outstanding</th>
                <th style={{ textAlign: "right" }}># invoices</th>
                <th style={{ textAlign: "right" }}>Oldest</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {summary.topDebtors.map((d) => {
                const badge = ageBadge(d.oldestAgeDays);
                return (
                  <tr key={d.xeroContactId}>
                    <td className="mono" style={{ fontSize: 13 }}>
                      {d.contactRef}
                      {d.exposureBreach && (
                        <span className="pill critical" style={{ marginLeft: 8, fontSize: 10 }}>over limit</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{d.entity}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtAmount(d.totalOutstanding)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 12 }}>{d.invoiceCount}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 12, color: badge.color }}>{d.oldestAgeDays}d ({badge.label})</td>
                    <td style={{ textAlign: "right" }}>
                      <Link href={`/reports/receivables/${d.xeroContactId}`} className="appbar-link" style={{ fontSize: 11 }}>
                        Drill in →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted" style={{ marginTop: 18, fontSize: 12 }}>
        Debtor names are masked in Mark&apos;s database (initials + last 4 of Xero contact ID).
        Click &quot;Drill in&quot; for the invoice list per debtor; open the matching record in Xero for the legal name.
      </p>
    </main>
  );
}

function KpiCard({ label, value, sub, color }: { label: string; value: number; sub?: string; color: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, marginTop: 4 }}>{fmtAmount(value)}</div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
