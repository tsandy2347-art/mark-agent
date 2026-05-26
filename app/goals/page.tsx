// /goals — goal metrics with full history.

import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
  const rows = await prisma.goalMetric.findMany({
    orderBy: { capturedAt: "desc" },
    take: 200,
  });

  // Group latest by (metric, entityScope) for the headline panel.
  const seen = new Set<string>();
  const latest = rows.filter((r) => {
    const k = `${r.metric}@${r.entityScope}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return (
    <main className="container">
      <h1>Goal metrics</h1>
      <p className="muted">
        Profit toward ${env.GOAL_PROFIT_TARGET_AUD.toLocaleString("en-AU")} is the headline. Labour
        cost %, DSO, unclaimed revenue, net GST are the supporting tape. Specialists emit these as
        findings with detector prefix <code>goal:</code>; Mark stores the trend.
      </p>

      <h2>Latest</h2>
      {latest.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No metrics yet.</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Scope</th>
                <th>Period</th>
                <th style={{ textAlign: "right" }}>Value</th>
                <th style={{ textAlign: "right" }}>Target</th>
                <th>Trend</th>
                <th>Captured</th>
              </tr>
            </thead>
            <tbody>
              {latest.map((m) => (
                <tr key={m.id}>
                  <td>{m.metric}</td>
                  <td className="mono">{m.entityScope}</td>
                  <td className="mono">{m.periodLabel}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{formatGoal(m.metric, Number(m.value))}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{m.target == null ? "—" : formatGoal(m.metric, Number(m.target))}</td>
                  <td>
                    <span className={`pill ${m.trend === "improving" ? "ok" : m.trend === "worsening" ? "critical" : "warning"}`}>
                      {m.trend}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{brisbane(m.capturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 22 }}>History</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Captured</th>
              <th>Metric</th>
              <th>Scope</th>
              <th style={{ textAlign: "right" }}>Value</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="mono" style={{ fontSize: 12 }}>{brisbane(m.capturedAt)}</td>
                <td>{m.metric}</td>
                <td className="mono">{m.entityScope}</td>
                <td className="mono" style={{ textAlign: "right" }}>{formatGoal(m.metric, Number(m.value))}</td>
                <td>
                  <span className={`pill ${m.trend === "improving" ? "ok" : m.trend === "worsening" ? "critical" : "warning"}`}>
                    {m.trend}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function formatGoal(metric: string, value: number): string {
  if (metric === "labour-cost-pct") return `${value.toFixed(1)}%`;
  if (metric === "dso") return `${value.toFixed(0)} days`;
  return `$${Math.round(value).toLocaleString("en-AU")}`;
}
