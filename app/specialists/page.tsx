// /specialists — health of all 7. Reads SpecialistRunStatus + descriptor list.

import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";
import { isStale } from "@/lib/mark/poll";
import { specialists, env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function SpecialistsPage() {
  const rows = await prisma.specialistRunStatus.findMany();
  const byAgent = new Map(rows.map((r) => [r.agent, r]));
  const descriptors = specialists();
  return (
    <main className="container">
      <h1>Specialist health</h1>
      <p className="muted">
        Mark polls each specialist's <code>/api/findings</code> with the shared <code>HUB_API_KEY</code>.
        A specialist not seen inside <code>{env.MARK_SPECIALIST_STALE_HOURS}h</code> is stale, and that
        silence is its own brief item.
      </p>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Specialist</th>
              <th>URL configured?</th>
              <th>Status</th>
              <th>Last run</th>
              <th style={{ textAlign: "right" }}>Open</th>
              <th>Last error</th>
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
                  <td>{d.url ? "yes" : <span className="dim">no</span>}</td>
                  <td>
                    <span className={`pill ${effective === "ok" || effective === "exceptions" ? "ok" : "critical"}`}>
                      {effective}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{r?.lastRunAt ? brisbane(r.lastRunAt) : "(never)"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{r?.exceptionsOpen ?? 0}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r?.lastError ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
