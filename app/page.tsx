// Mark's dashboard — today's headline, prioritised issues, cash position,
// specialist health, goal metrics.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";
import { isStale } from "@/lib/mark/poll";
import { readLatestMetrics } from "@/lib/mark/goals";
import { specialists, env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [latestBrief, openTodayIssues, openWeekIssues, restrictedOpen, statuses, latestMetrics, openFindings] = await Promise.all([
    prisma.financeBrief.findFirst({
      where: { briefType: "daily" },
      orderBy: { generatedAt: "desc" },
    }),
    prisma.correlatedIssue.findMany({
      where: { priority: "today", resolved: false, isRestricted: false },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.correlatedIssue.count({
      where: { priority: "this-week", resolved: false, isRestricted: false },
    }),
    prisma.correlatedIssue.count({
      where: { resolved: false, isRestricted: true },
    }),
    prisma.specialistRunStatus.findMany(),
    readLatestMetrics(),
    prisma.ingestedFinding.findMany({
      where: { resolved: false },
      select: { specialistAgent: true, entityCode: true, detector: true, amount: true, at: true, severity: true },
      take: 800,
    }),
  ]);

  const cash = recentCash(openFindings);
  const descriptors = specialists();
  const byAgent = new Map(statuses.map((s) => [s.agent, s]));
  const broken = descriptors
    .map((d) => ({
      d,
      r: byAgent.get(d.agent),
    }))
    .filter(({ r }) => !r || r.lastRunStatus === "failed" || isStale(r?.lastRunAt ?? null));

  return (
    <main className="container">
      <div className="hero">
        <div className="hero-eyebrow">JBC Finance · Manager</div>
        <h1 style={{ marginBottom: 6 }}>Mark</h1>
        <p className="muted" style={{ margin: 0 }}>
          Synthesises 7 specialists into one prioritised picture. Reports, escalates, never acts.
          Decisions stay with Tony, Nicole, and the external accountant.
        </p>

        {latestBrief ? (
          <div className="card" style={{ marginTop: 22 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>
              Headline · daily brief · {brisbane(latestBrief.generatedAt)}
            </div>
            <h2 style={{ margin: "8px 0 4px" }}>{latestBrief.headline}</h2>
            <Link href={`/briefs/${latestBrief.id}`} className="muted">Read brief →</Link>
          </div>
        ) : (
          <div className="card" style={{ marginTop: 22 }}>
            <div className="muted">No daily brief yet — trigger via <code>POST /api/cron/brief</code> or <code>npm run mark:brief</code>.</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 28, marginTop: 22, flexWrap: "wrap" }}>
          <Stat label="Today" value={openTodayIssues.length} color="var(--rose)" href="#today" />
          <Stat label="This week" value={openWeekIssues} color="var(--amber)" />
          <Stat label="Restricted open" value={restrictedOpen} color="var(--indigo)" href="/restricted" />
          <Stat label="Specialists silent" value={broken.length} color={broken.length > 0 ? "var(--rose)" : "var(--fg-muted)"} href="/specialists" />
        </div>
      </div>

      <h2 id="today" style={{ marginTop: 8 }}>Needs you today</h2>
      {openTodayIssues.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <p className="muted" style={{ margin: 0 }}>Nothing urgent. Good.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Entity</th>
                <th>Title</th>
                <th>From</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th>Flag</th>
              </tr>
            </thead>
            <tbody>
              {openTodayIssues.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.entityCode}</td>
                  <td>{i.title}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {Array.isArray(i.sourceAgents) ? (i.sourceAgents as string[]).join(", ") : "—"}
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {i.amount == null ? "—" : `$${Math.round(Math.abs(Number(i.amount))).toLocaleString("en-AU")}`}
                  </td>
                  <td>
                    {i.isConflict ? <span className="pill critical">conflict</span> : <span className="pill warning">action</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 22 }}>Cash position</h2>
      <div className="card" style={{ display: "flex", gap: 28, padding: 18 }}>
        <Stat label="SC" value={cash.SC == null ? "—" : `$${Math.round(cash.SC).toLocaleString("en-AU")}`} color="var(--accent)" />
        <Stat label="CQ" value={cash.CQ == null ? "—" : `$${Math.round(cash.CQ).toLocaleString("en-AU")}`} color="var(--accent)" />
      </div>

      <h2 style={{ marginTop: 22 }}>Goals</h2>
      {latestMetrics.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>
          No goal metrics captured yet — specialists need to emit detectors prefixed with <code>goal:</code>
          (e.g. <code>goal:profit-run-rate</code>) so Mark can store the trend.
        </p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Scope</th>
                <th style={{ textAlign: "right" }}>Value</th>
                <th style={{ textAlign: "right" }}>Target</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              {latestMetrics.map((m, idx) => (
                <tr key={`${m.metric}-${m.entityScope}-${idx}`}>
                  <td>{m.metric}</td>
                  <td className="mono">{m.entityScope}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{formatGoal(m.metric, m.value)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{m.target == null ? "—" : formatGoal(m.metric, m.target)}</td>
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
      )}

      <h2 style={{ marginTop: 22 }}>Specialist health</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Specialist</th>
              <th>Status</th>
              <th>Last run</th>
              <th style={{ textAlign: "right" }}>Open</th>
            </tr>
          </thead>
          <tbody>
            {descriptors.map((d) => {
              const r = byAgent.get(d.agent);
              const stale = isStale(r?.lastRunAt ?? null);
              const effective = stale ? "stale" : (r?.lastRunStatus ?? "never");
              return (
                <tr key={d.agent}>
                  <td>{d.label}</td>
                  <td>
                    <span className={`pill ${effective === "ok" || effective === "exceptions" ? "ok" : "critical"}`}>
                      {effective}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{r?.lastRunAt ? brisbane(r.lastRunAt) : "(never)"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{r?.exceptionsOpen ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 18, color: "var(--fg-dim)", fontSize: 12 }}>
        Profit target: ${env.GOAL_PROFIT_TARGET_AUD.toLocaleString("en-AU")}. Restricted items always
        route on their own channel — never the daily brief.
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  href,
  color,
}: {
  label: string;
  value: number | string;
  href?: string;
  color: string;
}) {
  const content = (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={{ color }}>{value}</span>
    </div>
  );
  if (href) {
    return (
      <Link href={href} style={{ textDecoration: "none" }}>
        {content}
      </Link>
    );
  }
  return content;
}

type FindingRow = {
  specialistAgent: string;
  entityCode: string;
  detector: string;
  amount: unknown;
  at: Date;
};

function recentCash(findings: FindingRow[]): { SC: number | null; CQ: number | null } {
  const out: { SC: number | null; CQ: number | null } = { SC: null, CQ: null };
  const candidates = findings.filter((f) => f.specialistAgent === "reconciliation" && /cash-?position/i.test(f.detector));
  const sorted = [...candidates].sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const f of sorted) {
    if (f.amount == null) continue;
    const n = Number(f.amount);
    if (!Number.isFinite(n)) continue;
    if (f.entityCode === "SC" && out.SC == null) out.SC = n;
    if (f.entityCode === "CQ" && out.CQ == null) out.CQ = n;
  }
  return out;
}

function formatGoal(metric: string, value: number): string {
  if (metric === "labour-cost-pct") return `${value.toFixed(1)}%`;
  if (metric === "dso") return `${value.toFixed(0)} days`;
  return `$${Math.round(value).toLocaleString("en-AU")}`;
}
