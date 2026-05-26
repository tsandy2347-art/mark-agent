// One brief rendered.

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function BriefPage(ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const brief = await prisma.financeBrief.findUnique({
    where: { id },
    include: { correlatedIssues: { orderBy: [{ priority: "asc" }, { createdAt: "desc" }] } },
  });
  if (!brief) notFound();

  const today = brief.correlatedIssues.filter((c) => c.priority === "today");
  const week = brief.correlatedIssues.filter((c) => c.priority === "this-week");
  const notes = brief.correlatedIssues.filter((c) => c.priority === "note");
  const sourced = brief.sourcedRunIds as unknown as Array<{
    agent: string;
    lastRunAt: string | null;
    lastRunStatus: string;
    exceptionsOpen: number;
  }>;

  return (
    <main className="container">
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>
        {brief.briefType} brief · {brisbane(brief.generatedAt)}
      </div>
      <h1>{brief.headline}</h1>

      <div className="card" style={{ whiteSpace: "pre-wrap" }}>
        {brief.narrative}
      </div>

      {today.length > 0 && (
        <>
          <h2 style={{ marginTop: 22 }}>Needs you today ({today.length})</h2>
          <IssueList issues={today} />
        </>
      )}

      {week.length > 0 && (
        <>
          <h2 style={{ marginTop: 22 }}>This week ({week.length})</h2>
          <IssueList issues={week} />
        </>
      )}

      {notes.length > 0 && (
        <>
          <h2 style={{ marginTop: 22 }}>Notes ({notes.length})</h2>
          <IssueList issues={notes} />
        </>
      )}

      <h2 style={{ marginTop: 22 }}>Specialist runs this brief drew on</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Last run</th>
              <th style={{ textAlign: "right" }}>Open</th>
            </tr>
          </thead>
          <tbody>
            {(Array.isArray(sourced) ? sourced : []).map((s) => (
              <tr key={s.agent}>
                <td>{s.agent}</td>
                <td>
                  <span className={`pill ${s.lastRunStatus === "ok" || s.lastRunStatus === "exceptions" ? "ok" : "critical"}`}>
                    {s.lastRunStatus}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>{s.lastRunAt ? brisbane(s.lastRunAt) : "(never)"}</td>
                <td className="mono" style={{ textAlign: "right" }}>{s.exceptionsOpen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 18, color: "var(--fg-dim)", fontSize: 12 }}>
        Delivery: {brief.deliveryStatus}. Recipients: {brief.recipients || "(none)"}.
        {brief.deliveryError ? ` Error: ${brief.deliveryError}` : ""}
      </div>
    </main>
  );
}

function IssueList({
  issues,
}: {
  issues: Array<{
    id: string;
    title: string;
    detail: string;
    entityCode: string;
    amount: { toString(): string } | null;
    sourceAgents: unknown;
    isConflict: boolean;
    isRestricted: boolean;
  }>;
}) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <table>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Title / detail</th>
            <th>From</th>
            <th style={{ textAlign: "right" }}>Amount</th>
            <th>Flag</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => (
            <tr key={i.id}>
              <td className="mono">{i.entityCode}</td>
              <td>
                <div>{i.title}</div>
                <div className="muted" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{i.detail}</div>
              </td>
              <td className="muted" style={{ fontSize: 12 }}>
                {Array.isArray(i.sourceAgents) ? (i.sourceAgents as string[]).join(", ") : "—"}
              </td>
              <td className="mono" style={{ textAlign: "right" }}>
                {i.amount == null ? "—" : `$${Math.round(Math.abs(Number(i.amount))).toLocaleString("en-AU")}`}
              </td>
              <td>
                {i.isConflict ? (
                  <span className="pill critical">conflict</span>
                ) : i.isRestricted ? (
                  <span className="pill warning">restricted</span>
                ) : (
                  <span className="pill ok">action</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
