// /financials — Tony uploads the Xero "Profit and Loss" (compared by month)
// export for each entity. We parse every closed month into MonthlyFinancials so
// Mark answers profit history from his own DB and only calls Xero for the
// current, still-moving month — protecting the daily Xero API cap.

import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";

export const dynamic = "force-dynamic";

function fmtMonth(m: string): string {
  // "2026-04" → "Apr 2026"
  const [y, mo] = m.split("-");
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(mo)] || mo} ${y}`;
}

function money(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
}

async function loadStored(entityCode: string) {
  return prisma.monthlyFinancials.findMany({
    where: { entityCode },
    orderBy: { month: "desc" },
    select: {
      month: true,
      totalIncome: true,
      netProfit: true,
      sourceFilename: true,
      uploadedBy: true,
      updatedAt: true,
    },
  });
}

const ACCEPT =
  ".xlsx,.xls,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ENTITIES = [
  { code: "SC", name: "Sunshine Coast" },
  { code: "CQ", name: "Central Queensland" },
];

export default async function FinancialsPage() {
  const stored = await Promise.all(ENTITIES.map((e) => loadStored(e.code)));

  return (
    <main className="container" style={{ maxWidth: 980 }}>
      <h1>Profit history</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Upload the Profit &amp; Loss export from Xero for each company. In Xero go
        to <b>Reports → Profit and Loss</b>, set it to compare <b>by month</b>{" "}
        across the period you want (e.g. last 24 months), then{" "}
        <b>Export → Excel</b>. Drop the file below. Mark reads each finished month
        into his own memory <b>once</b> — after that he answers questions about
        those months instantly, without going back to Xero. He only checks Xero
        live for the current month that&apos;s still changing. Re-uploading a
        month simply updates it.
      </p>

      {ENTITIES.map((ent, idx) => (
        <section key={ent.code} className="card" style={{ marginBottom: 22 }}>
          <h2 style={{ marginTop: 0 }}>
            {ent.name} <span className="mono" style={{ fontSize: 13, color: "var(--fg-muted,#8a96ac)" }}>({ent.code})</span>
          </h2>

          <form
            method="POST"
            action="/api/financials/upload"
            encType="multipart/form-data"
            style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "end", marginTop: 12 }}
          >
            <input type="hidden" name="entityCode" value={ent.code} />
            <div>
              <label className="field-label" htmlFor={`file-${ent.code}`}>
                Xero Profit &amp; Loss file (Excel or CSV)
              </label>
              <input id={`file-${ent.code}`} type="file" name="file" accept={ACCEPT} required style={{ width: "100%" }} />
            </div>
            <button type="submit" className="btn btn-primary">Upload</button>
          </form>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Excel / CSV · max 25 MB · each month is read once and stored; re-upload to update.
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6 }}>
              Months Mark has stored — {stored[idx].length} month{stored[idx].length === 1 ? "" : "s"}
            </div>
            {stored[idx].length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>
                Nothing stored yet — upload a file above and Mark will remember it.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--fg-muted, #8a96ac)" }}>
                    <th style={{ padding: "4px 6px" }}>Month</th>
                    <th style={{ padding: "4px 6px", textAlign: "right" }}>Income</th>
                    <th style={{ padding: "4px 6px", textAlign: "right" }}>Net profit</th>
                    <th style={{ padding: "4px 6px" }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {stored[idx].map((row) => (
                    <tr key={row.month}>
                      <td className="mono" style={{ padding: "4px 6px" }}>{fmtMonth(row.month)}</td>
                      <td className="mono" style={{ padding: "4px 6px", textAlign: "right" }}>{money(row.totalIncome)}</td>
                      <td
                        className="mono"
                        style={{ padding: "4px 6px", textAlign: "right", color: (row.netProfit ?? 0) < 0 ? "var(--red,#f43f5e)" : undefined }}
                      >
                        {money(row.netProfit)}
                      </td>
                      <td className="mono" style={{ padding: "4px 6px", fontSize: 12 }}>{brisbane(row.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ))}
    </main>
  );
}
