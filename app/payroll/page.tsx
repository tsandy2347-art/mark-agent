// /payroll — Tony uploads the MYOB "Pay Activity Detail Data" export here. Mark
// groups the weekly pay runs into months and breaks labour cost down by pay type
// (ordinary, overtime, casual loading, travel, leave, super, allowances) so he
// can answer cost questions without going to the payroll system each time.

import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";

export const dynamic = "force-dynamic";

function fmtMonth(m: string): string {
  const [y, mo] = m.split("-");
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(mo)] || mo} ${y}`;
}

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
}

async function loadStored(entityCode: string) {
  return prisma.payrollMonth.findMany({
    where: { entityCode },
    orderBy: { month: "desc" },
    select: { month: true, totalGross: true, totalSuper: true, totalAllowances: true, payRuns: true, updatedAt: true },
  });
}

const ACCEPT =
  ".xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ENTITIES = [
  { code: "SC", name: "Sunshine Coast" },
  { code: "CQ", name: "Central Queensland" },
];

export default async function PayrollPage() {
  const stored = await Promise.all(ENTITIES.map((e) => loadStored(e.code)));

  return (
    <main className="container" style={{ maxWidth: 980 }}>
      <h1>Payroll detail</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Upload the <b>Pay Activity Detail Data</b> export from MYOB (one file
        covers both companies). Mark reads each weekly pay run, groups them into
        the month the pay date falls in, and breaks the labour cost down by pay
        type — ordinary hours, overtime, casual loading, weekend &amp; shift
        loadings, travel, leave, super and allowances. After that you can ask him
        things like &ldquo;how much overtime did Sunshine Coast pay last
        month&rdquo; or &ldquo;what&rsquo;s our travel-allowance spend&rdquo;.
        Upload each new pay run as it happens; re-uploading the same run just
        updates it.
      </p>

      <section className="card" style={{ marginBottom: 22 }}>
        <h2 style={{ marginTop: 0 }}>Upload a pay run</h2>
        <form
          method="POST"
          action="/api/payroll/upload"
          encType="multipart/form-data"
          style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "end", marginTop: 12 }}
        >
          <div>
            <label className="field-label" htmlFor="payroll-file">
              MYOB Pay Activity Detail Data file (Excel)
            </label>
            <input id="payroll-file" type="file" name="file" accept={ACCEPT} required style={{ width: "100%" }} />
          </div>
          <button type="submit" className="btn btn-primary">Upload</button>
        </form>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Excel · max 25 MB · both companies detected automatically from the pay-run name.
        </div>
      </section>

      {ENTITIES.map((ent, idx) => (
        <section key={ent.code} className="card" style={{ marginBottom: 22 }}>
          <h2 style={{ marginTop: 0 }}>
            {ent.name} <span className="mono" style={{ fontSize: 13, color: "var(--fg-muted,#8a96ac)" }}>({ent.code})</span>
          </h2>
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6 }}>
            Months Mark has stored — {stored[idx].length}
          </div>
          {stored[idx].length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>Nothing stored yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--fg-muted, #8a96ac)" }}>
                  <th style={{ padding: "4px 6px" }}>Month</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Gross wages</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Super</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Allowances</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Pay runs</th>
                  <th style={{ padding: "4px 6px" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {stored[idx].map((row) => (
                  <tr key={row.month}>
                    <td className="mono" style={{ padding: "4px 6px" }}>{fmtMonth(row.month)}</td>
                    <td className="mono" style={{ padding: "4px 6px", textAlign: "right" }}>{money(row.totalGross)}</td>
                    <td className="mono" style={{ padding: "4px 6px", textAlign: "right" }}>{money(row.totalSuper)}</td>
                    <td className="mono" style={{ padding: "4px 6px", textAlign: "right" }}>{money(row.totalAllowances)}</td>
                    <td className="mono" style={{ padding: "4px 6px", textAlign: "right" }}>
                      {Array.isArray(row.payRuns) ? (row.payRuns as unknown[]).length : 0}
                    </td>
                    <td className="mono" style={{ padding: "4px 6px", fontSize: 12 }}>{brisbane(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </main>
  );
}
