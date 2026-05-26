// /restricted — people-flag + individual-pay items.
//
// Gated server-side to MARK_RESTRICTED_USERNAMES (Tony + Lindsay + Nicole by
// default). Any other logged-in user sees a "not authorised" notice with no
// data, regardless of having Basic-auth.

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";
import { restrictedUsernames } from "@/lib/env";

export const dynamic = "force-dynamic";

async function currentUsername(): Promise<string | null> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    return decoded.split(":")[0].toLowerCase();
  } catch {
    return null;
  }
}

export default async function RestrictedPage() {
  const me = await currentUsername();
  const allowed = me ? restrictedUsernames().includes(me) : false;
  if (!allowed) {
    return (
      <main className="container">
        <h1>Restricted</h1>
        <div className="card">
          <p style={{ margin: 0 }}>
            Not authorised. The restricted page is gated to <code>MARK_RESTRICTED_USERNAMES</code>
            (Tony + Lindsay + Nicole by default). If you should have access, ask Tony to add your
            Basic-auth username to that list.
          </p>
        </div>
      </main>
    );
  }

  const issues = await prisma.correlatedIssue.findMany({
    where: { isRestricted: true, resolved: false },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    take: 100,
  });

  const latestBrief = await prisma.financeBrief.findFirst({
    where: { briefType: "restricted" },
    orderBy: { generatedAt: "desc" },
  });

  return (
    <main className="container">
      <h1>Restricted</h1>
      <p className="muted">
        People-flag and individual-pay items. These go only on the restricted email channel — they
        never appear on the daily, weekly, or monthly brief. Neutral language: each item is a signal
        for review, not a finding.
      </p>

      {latestBrief && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>
            Latest restricted brief · {brisbane(latestBrief.generatedAt)}
          </div>
          <h2 style={{ margin: "8px 0 4px" }}>{latestBrief.headline}</h2>
          <div style={{ whiteSpace: "pre-wrap" }}>{latestBrief.narrative}</div>
        </div>
      )}

      <h2 style={{ marginTop: 22 }}>Open restricted items ({issues.length})</h2>
      {issues.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 30 }}>
          <p className="muted" style={{ margin: 0 }}>Nothing restricted right now.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Entity</th>
                <th>Priority</th>
                <th>Title</th>
                <th>From</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.entityCode}</td>
                  <td>
                    <span className={`pill ${i.priority === "today" ? "critical" : i.priority === "this-week" ? "warning" : "ok"}`}>
                      {i.priority}
                    </span>
                  </td>
                  <td>
                    <div>{i.title}</div>
                    <div className="muted" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{i.detail}</div>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {Array.isArray(i.sourceAgents) ? (i.sourceAgents as string[]).join(", ") : "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{brisbane(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
