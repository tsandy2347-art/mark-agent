// Recent briefs index.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function BriefsPage() {
  const briefs = await prisma.financeBrief.findMany({
    orderBy: { generatedAt: "desc" },
    take: 50,
  });
  return (
    <main className="container">
      <h1>Briefs</h1>
      <p className="muted">
        Every brief Mark has assembled. Each one stores the underlying specialist run states it drew
        on so it's replayable for audit.
      </p>
      {briefs.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <p className="muted" style={{ margin: 0 }}>
            No briefs yet. Trigger one: <code>npm run mark:brief -- daily</code>
            {" or "}<code>POST /api/cron/brief {"{ briefType: \"daily\" }"}</code>.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Headline</th>
                <th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {briefs.map((b) => (
                <tr key={b.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{brisbane(b.generatedAt)}</td>
                  <td>
                    <span className="pill ok">{b.briefType}</span>
                  </td>
                  <td>
                    <Link href={`/briefs/${b.id}`}>{b.headline || "(no headline)"}</Link>
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        b.deliveryStatus === "sent"
                          ? "ok"
                          : b.deliveryStatus === "error"
                            ? "critical"
                            : "warning"
                      }`}
                    >
                      {b.deliveryStatus}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
