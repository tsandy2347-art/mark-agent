// /imports — Tony / Lindsay drop MYOB pay exports + AlayaCare service
// delivery exports here. Two cards, two upload forms, recent-uploads table
// under each. The Hermes skills pull the latest of each kind via
// GET /api/imports/{kind}/latest on every run.

import { prisma } from "@/lib/prisma";
import { brisbane } from "@/lib/time";

export const dynamic = "force-dynamic";

interface KindSpec {
  kind: "myob" | "alayacare";
  title: string;
  blurb: string;
  consumer: string;
  accept: string;
}

const KINDS: KindSpec[] = [
  {
    kind: "myob",
    title: "MYOB pay export",
    blurb:
      "Drop the latest pay-period export from MYOB. Used by the payroll & labour skill to detect super shortfalls, PAYG anomalies, and period-over-period variance.",
    consumer: "jbc-payroll-labour",
    accept: ".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    kind: "alayacare",
    title: "AlayaCare service delivery export",
    blurb:
      "Drop the latest billable-visits / service-delivery export from AlayaCare. Used by the revenue & claims skill to detect unclaimed revenue and billing leakage.",
    consumer: "jbc-revenue-claims",
    accept: ".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
];

async function loadLatest(kind: string) {
  return prisma.csvImport.findMany({
    where: { kind },
    orderBy: { uploadedAt: "desc" },
    take: 5,
    select: {
      id: true,
      filename: true,
      sizeBytes: true,
      uploadedAt: true,
      uploadedBy: true,
      processedAt: true,
      entityCode: true,
    },
  });
}

export default async function ImportsPage() {
  const recent = await Promise.all(KINDS.map((k) => loadLatest(k.kind)));

  return (
    <main className="container" style={{ maxWidth: 980 }}>
      <h1>Imports</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Drop source-system exports here. Mark holds the raw file in his database
        and the read-only Hermes skills fetch the latest of each kind on every
        run (they live on a separate Railway service with its own volume — HTTP
        is how they see the file). Upload again to replace; nothing is deleted,
        we just pick the newest row.
      </p>

      {KINDS.map((spec, idx) => (
        <section key={spec.kind} className="card" style={{ marginBottom: 22 }}>
          <h2 style={{ marginTop: 0 }}>{spec.title}</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            {spec.blurb}{" "}
            <span className="mono" style={{ fontSize: 12 }}>
              → consumed by {spec.consumer}
            </span>
          </p>

          <form
            method="POST"
            action="/api/imports/upload"
            encType="multipart/form-data"
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr auto",
              gap: 12,
              alignItems: "end",
              marginTop: 12,
            }}
          >
            <input type="hidden" name="kind" value={spec.kind} />
            <div>
              <label className="field-label" htmlFor={`ent-${spec.kind}`}>
                Entity (optional)
              </label>
              <select
                id={`ent-${spec.kind}`}
                name="entityCode"
                defaultValue=""
                style={{ width: "100%" }}
              >
                <option value="">— both / unspecified —</option>
                <option value="SC">SC</option>
                <option value="CQ">CQ</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor={`file-${spec.kind}`}>
                File
              </label>
              <input
                id={`file-${spec.kind}`}
                type="file"
                name="file"
                accept={spec.accept}
                required
                style={{ width: "100%" }}
              />
            </div>
            <button type="submit" className="btn btn-primary">
              Upload
            </button>
          </form>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            CSV / XLSX / PDF · max 50 MB · uploads are append-only, newest wins.
          </div>

          <div style={{ marginTop: 16 }}>
            <div
              className="muted"
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 1.2,
                marginBottom: 6,
              }}
            >
              Recent uploads
            </div>
            {recent[idx].length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>
                No uploads yet.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--fg-muted, #8a96ac)" }}>
                    <th style={{ padding: "4px 6px" }}>Filename</th>
                    <th style={{ padding: "4px 6px" }}>Entity</th>
                    <th style={{ padding: "4px 6px", textAlign: "right" }}>Size</th>
                    <th style={{ padding: "4px 6px" }}>Uploaded</th>
                    <th style={{ padding: "4px 6px" }}>By</th>
                    <th style={{ padding: "4px 6px" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent[idx].map((row, i) => (
                    <tr key={row.id}>
                      <td className="mono" style={{ padding: "4px 6px" }}>
                        {row.filename}
                        {i === 0 ? (
                          <span
                            className="pill ok"
                            style={{ marginLeft: 6, fontSize: 10 }}
                          >
                            latest
                          </span>
                        ) : null}
                      </td>
                      <td className="mono" style={{ padding: "4px 6px" }}>
                        {row.entityCode ?? "—"}
                      </td>
                      <td className="mono" style={{ padding: "4px 6px", textAlign: "right" }}>
                        {(row.sizeBytes / 1024).toFixed(0)} KB
                      </td>
                      <td className="mono" style={{ padding: "4px 6px", fontSize: 12 }}>
                        {brisbane(row.uploadedAt)}
                      </td>
                      <td className="mono" style={{ padding: "4px 6px", fontSize: 12 }}>
                        {row.uploadedBy}
                      </td>
                      <td style={{ padding: "4px 6px" }}>
                        {row.processedAt ? (
                          <span className="pill ok">processed</span>
                        ) : (
                          <span className="pill warning">pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ))}

      <div style={{ marginTop: 18, color: "var(--fg-dim)", fontSize: 12 }}>
        Skills fetch via <span className="mono">GET /api/imports/{`{kind}`}/latest</span>{" "}
        with the same Basic auth header. The bytes live in Postgres so a
        separate Railway service with its own volume can still see them.
      </div>
    </main>
  );
}
