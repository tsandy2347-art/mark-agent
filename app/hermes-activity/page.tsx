// /hermes-activity — visibility into the Hermes finance fleet.
//
// Every Hermes finance skill (controls-audit, receivables, revenue-claims,
// tax-compliance, payroll-labour mirror, reconciliation mirror) writes to a
// shared findings DB. This page is the human-readable view on top of it so
// Tony can confirm at a glance that the Hermes side is alive and producing.
//
// Read-only. No actions, no resolve buttons. Use /qa to drill in.

import { brisbane } from "@/lib/time";
import { env } from "@/lib/env";
import {
  hermesConfigured,
  listRecentAuditRuns,
  listRecentFindings,
  listSkillInventory,
  summariseByAgent,
} from "@/lib/hermes-findings";

export const dynamic = "force-dynamic";
// Auto-refresh server-side every 60s. The page itself stays cheap because
// dynamic + revalidate=60 makes the framework re-render on demand without
// caching across requests.
export const revalidate = 60;

function severityClass(sev: string): string {
  if (sev === "critical") return "critical";
  if (sev === "warning") return "warn";
  return "ok";
}

function fmtAmount(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

export default async function HermesActivityPage() {
  if (!hermesConfigured()) {
    return (
      <main className="container">
        <h1>Hermes activity</h1>
        <p className="muted">
          Hermes findings DB not configured yet. Set
          <code> HERMES_FINDINGS_DATABASE_URL </code>
          on this service (the public-proxy URL of the hermes-jbc Postgres,
          from Railway dashboard → hermes-jbc project → Postgres service →{" "}
          <code>DATABASE_PUBLIC_URL</code>).
        </p>
      </main>
    );
  }

  const [bySkill, runs, findings, inventory] = await Promise.all([
    summariseByAgent(),
    listRecentAuditRuns(30),
    listRecentFindings(30),
    listSkillInventory(200),
  ]);

  // Heuristic: a skill modified within the last 6h that ISN'T one of the
  // skills we baked at deploy time is likely agent-authored. We don't know
  // the deploy timestamp here so "recently modified" is the proxy.
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const recentSkills = inventory.filter((s) => s.mtime > sixHoursAgo);

  return (
    <main className="container">
      <h1>Hermes activity</h1>
      <p className="muted">
        Live view of the Hermes finance fleet — one row per skill, plus the
        latest 30 cron ticks and findings. Refreshes server-side every 60s.
        Data source: <code>FINDINGS_DATABASE_URL</code> on hermes-jbc.
      </p>

      <h2 style={{ marginTop: 24 }}>Skills inventory ({inventory.length} on disk)</h2>
      <p className="muted">
        Live walk of <code>$HERMES_HOME/skills/</code> on the hermes-jbc
        container, refreshed every 10 min by the <code>skill-inventory</code>
        cron. Rows sorted by file mtime DESC — anything new or recently
        modified (incl. anything Hermes authored autonomously via{" "}
        <code>skill_manage</code>) shows up at the top.
        {recentSkills.length > 0 && (
          <>
            {" "}
            <strong style={{ color: "#0066cc" }}>
              {recentSkills.length} modified in the last 6h.
            </strong>
          </>
        )}
      </p>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Skill</th>
              <th>Namespace</th>
              <th>Description</th>
              <th>Last modified</th>
            </tr>
          </thead>
          <tbody>
            {inventory.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No inventory yet. First scan runs within 10 min of the next
                  hermes-jbc deploy.
                </td>
              </tr>
            )}
            {inventory.slice(0, 60).map((s) => {
              const isRecent = s.mtime > sixHoursAgo;
              return (
                <tr key={s.path} style={isRecent ? { background: "#fff8e1" } : undefined}>
                  <td>
                    <strong>{s.name}</strong>
                    {isRecent && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 11,
                          color: "#b8860b",
                          fontWeight: 600,
                        }}
                      >
                        NEW/MOD
                      </span>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {s.parent || "(root)"}
                  </td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 480 }}>
                    {s.description || "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {brisbane(s.mtime)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {inventory.length > 60 && (
        <p className="muted" style={{ fontSize: 12 }}>
          Showing top 60 of {inventory.length}.
        </p>
      )}

      <h2 style={{ marginTop: 24 }}>Run summary by source agent</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Skill</th>
              <th>Last run</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Open</th>
              <th style={{ textAlign: "right" }}>Critical</th>
              <th style={{ textAlign: "right" }}>Total runs</th>
            </tr>
          </thead>
          <tbody>
            {bySkill.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No Hermes runs recorded yet. First cron tick is 21:00 UTC
                  (07:00 AEST) for controls-audit.
                </td>
              </tr>
            )}
            {bySkill.map((s) => (
              <tr key={s.sourceAgent}>
                <td>
                  <strong>{s.sourceAgent}</strong>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {s.lastRunAt ? brisbane(s.lastRunAt) : "(never)"}
                </td>
                <td>
                  <span
                    className={`pill ${
                      s.lastStatus === "ok" || s.lastStatus === "exceptions"
                        ? "ok"
                        : "critical"
                    }`}
                  >
                    {s.lastStatus ?? "never"}
                  </span>
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {s.openCount}
                </td>
                <td
                  className="mono"
                  style={{
                    textAlign: "right",
                    color: s.openCritical > 0 ? "#c1121f" : undefined,
                    fontWeight: s.openCritical > 0 ? 600 : undefined,
                  }}
                >
                  {s.openCritical}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {s.totalRuns}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 24 }}>Recent cron ticks</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>When (Brisbane)</th>
              <th>Skill</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Findings</th>
              <th style={{ textAlign: "right" }}>Critical</th>
              <th style={{ textAlign: "right" }}>Duration</th>
              <th>Failure</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="mono" style={{ fontSize: 12 }}>
                  {brisbane(r.runAt)}
                </td>
                <td>{r.sourceAgent}</td>
                <td>
                  <span
                    className={`pill ${
                      r.status === "ok" || r.status === "exceptions"
                        ? "ok"
                        : "critical"
                    }`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {r.exceptionsCount}
                </td>
                <td
                  className="mono"
                  style={{
                    textAlign: "right",
                    color: r.criticalCount > 0 ? "#c1121f" : undefined,
                    fontWeight: r.criticalCount > 0 ? 600 : undefined,
                  }}
                >
                  {r.criticalCount}
                </td>
                <td className="mono" style={{ textAlign: "right", fontSize: 12 }}>
                  {r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {r.failureNote ? r.failureNote.slice(0, 60) + (r.failureNote.length > 60 ? "…" : "") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 24 }}>Recent findings</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Skill</th>
              <th>Detector</th>
              <th>Entity</th>
              <th>Severity</th>
              <th>Title</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {findings.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No findings yet.
                </td>
              </tr>
            )}
            {findings.map((f) => (
              <tr key={f.id}>
                <td className="mono" style={{ fontSize: 12 }}>
                  {brisbane(f.createdAt)}
                </td>
                <td>{f.sourceAgent}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {f.detector}
                </td>
                <td>{f.entityCode}</td>
                <td>
                  <span className={`pill ${severityClass(f.severity)}`}>{f.severity}</span>
                </td>
                <td style={{ maxWidth: 420 }}>
                  <div>{f.title}</div>
                  {f.aiExplanation && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {f.aiExplanation}
                    </div>
                  )}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {fmtAmount(f.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
        Stale-window: a Hermes skill that hasn't recorded a run inside{" "}
        <code>{env.MARK_SPECIALIST_STALE_HOURS}h</code> is silent — same rule
        Mark uses for the standalone specialists.
      </p>
    </main>
  );
}
