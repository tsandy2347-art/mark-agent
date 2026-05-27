// /sources/upload — fleet-wide source-data upload hub.
//
// Single front door for "I have a spreadsheet, who eats it?". The dropdown
// shows every source type the fleet knows about — with status:
//   - ✅ live: pick file + entity + upload (forwards to the right specialist)
//   - ↗ external: the existing payroll-analyser handles this — link out
//   - … coming next: scaffolded but not wired yet
//
// Today only MYOB Pay Export is live. The rest are placeholders so the
// roadmap is visible. Phase 1B wires AlayaCare / PAPL / Bank CSV / Tax.

"use client";

import { useRef, useState } from "react";

interface RouteRow {
  sourceType: string;
  label: string;
  owner: string;
  available: boolean;
  externalUrl?: string;
}

// Mirror of SOURCE_ROUTES in app/api/sources/upload/route.ts. Kept in sync
// by hand; if the routing table changes server-side, update this list too.
const ROUTES: RouteRow[] = [
  { sourceType: "myob-pay-export", label: "MYOB Pay Export", owner: "Payroll & Labour", available: true },
  { sourceType: "alayacare-roster", label: "AlayaCare — Roster Export", owner: "Payroll & Labour", available: false },
  { sourceType: "alayacare-billable", label: "AlayaCare — Billable Visits", owner: "Revenue & Claims", available: false },
  { sourceType: "ndis-papl", label: "NDIS Price Arrangements (PAPL XLSX)", owner: "Revenue & Claims", available: false },
  { sourceType: "bank-csv", label: "Bank Statement CSV", owner: "Reconciliation", available: false },
  { sourceType: "tax-workpaper", label: "Tax Workpaper / GST Mapping", owner: "Tax & Compliance", available: false },
  {
    sourceType: "mirus-post-data",
    label: "Mirus Post-Payroll Data",
    owner: "Payroll Analyser (separate tool)",
    available: false,
    externalUrl: "https://jbc-payroll-analyser-production.up.railway.app/",
  },
];

interface UploadResult {
  ok: boolean;
  sourceLabel?: string;
  target?: string;
  ingestBatchId?: string;
  byteSize?: number;
  isDuplicate?: boolean;
  uploadedBy?: string;
  sheetSummary?: Array<{ name: string; rowCount: number; columnHeaders: string[] }> | null;
  parseError?: string | null;
  error?: string;
  externalUrl?: string;
  message?: string;
}

const ACCEPT_ATTRIBUTE = [
  ".xlsx", ".xls", ".ods", ".csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
].join(",");

export default function SourcesUploadPage() {
  const [sourceType, setSourceType] = useState<string>("myob-pay-export");
  const [entity, setEntity] = useState<"" | "SC" | "CQ">("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedRoute = ROUTES.find((r) => r.sourceType === sourceType);
  const canUpload = Boolean(selectedRoute?.available);

  function pickFile() {
    fileInputRef.current?.click();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setResult(null);
  }

  function clearFile() {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("sourceType", sourceType);
      if (entity) form.append("entityCode", entity);
      form.append("file", file);
      const res = await fetch("/api/sources/upload", { method: "POST", body: form });
      const json = (await res.json()) as UploadResult;
      setResult(json);
      if (json.ok) {
        clearFile();
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container" style={{ maxWidth: 820 }}>
      <h1>Upload source data</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Drop an export here and it's routed to the specialist that owns it.
        Today MYOB Pay Export is live; the rest of the source types are
        scaffolded — they'll come online as each parser lands. Mirus
        post-payroll data goes to the existing Payroll Analyser tool.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <label className="field-label" htmlFor="srctype">Source type</label>
        <select
          id="srctype"
          value={sourceType}
          onChange={(e) => {
            setSourceType(e.target.value);
            setResult(null);
          }}
          disabled={busy}
          style={{ width: "100%" }}
        >
          {ROUTES.map((r) => (
            <option key={r.sourceType} value={r.sourceType}>
              {r.available ? "✅" : r.externalUrl ? "↗" : "…"} {r.label}  ·  {r.owner}
            </option>
          ))}
        </select>

        {selectedRoute && !selectedRoute.available ? (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 6,
              background: "var(--amber-soft, rgba(251,191,36,0.14))",
              color: "var(--amber, #fbbf24)",
              fontSize: 13,
            }}
          >
            {selectedRoute.externalUrl ? (
              <>
                {selectedRoute.label} is handled by a separate tool.{" "}
                <a href={selectedRoute.externalUrl} target="_blank" rel="noopener noreferrer">
                  Open the Payroll Analyser →
                </a>
              </>
            ) : (
              <>
                {selectedRoute.label} ingest isn't wired yet — coming in Phase 1B.
                The dropdown shows it so the roadmap is visible.
              </>
            )}
          </div>
        ) : null}

        {canUpload ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, alignItems: "end", marginTop: 14 }}>
              <div>
                <label className="field-label" htmlFor="ent">Entity (optional)</label>
                <select
                  id="ent"
                  value={entity}
                  onChange={(e) => setEntity(e.target.value as "" | "SC" | "CQ")}
                  disabled={busy}
                  style={{ width: "100%" }}
                >
                  <option value="">— file spans both / not specified —</option>
                  <option value="SC">SC</option>
                  <option value="CQ">CQ</option>
                </select>
              </div>
              <div>
                <label className="field-label">File</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPT_ATTRIBUTE}
                    onChange={onFile}
                    style={{ display: "none" }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={pickFile}
                    disabled={busy}
                    style={{ background: "transparent", border: "1px solid currentColor" }}
                  >
                    {file ? "Replace file" : "Choose file"}
                  </button>
                  {file ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      📎 {file.name} ({(file.size / 1024).toFixed(0)} KB)
                      <button
                        type="button"
                        onClick={clearFile}
                        disabled={busy}
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--fg-dim)", marginLeft: 6 }}
                      >
                        ✕
                      </button>
                    </span>
                  ) : (
                    <span className="muted" style={{ fontSize: 12 }}>.xlsx / .xls / .ods / .csv · max 30 MB</span>
                  )}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <button
                className="btn btn-primary"
                onClick={submit}
                disabled={busy || !file}
              >
                {busy ? "Uploading…" : "Upload"}
              </button>
              <span className="muted" style={{ fontSize: 12, marginLeft: 12 }}>
                Routed to {selectedRoute?.owner}. Stored + audited; your basic-auth name is captured.
              </span>
            </div>
          </>
        ) : null}
      </div>

      {result ? (
        <div className="card">
          {result.ok ? (
            <>
              <div style={{ color: "var(--emerald, #34d399)", fontWeight: 600, marginBottom: 6 }}>
                ✓ Uploaded to {result.target}
                {result.isDuplicate ? " (duplicate detected — using prior batch)" : ""}
              </div>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                <div>Source: <span className="mono">{result.sourceLabel}</span></div>
                <div>Batch id: <span className="mono">{result.ingestBatchId}</span></div>
                <div>Size: {result.byteSize ? (result.byteSize / 1024).toFixed(0) + " KB" : "?"}</div>
                <div>Uploaded by: <span className="mono">{result.uploadedBy}</span></div>
                {result.message ? <div className="muted" style={{ marginTop: 6 }}>{result.message}</div> : null}
                {result.parseError ? (
                  <div style={{ color: "var(--rose, #f43f5e)", marginTop: 6 }}>
                    Parse warning: {result.parseError}
                  </div>
                ) : null}
              </div>
              {Array.isArray(result.sheetSummary) && result.sheetSummary.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6 }}>
                    What we saw in the file
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--fg-muted, #8a96ac)" }}>
                        <th style={{ padding: "4px 6px" }}>Sheet</th>
                        <th style={{ padding: "4px 6px", width: 70 }}>Rows</th>
                        <th style={{ padding: "4px 6px" }}>Columns (first 10)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.sheetSummary.map((s) => (
                        <tr key={s.name}>
                          <td style={{ padding: "4px 6px" }}><span className="mono">{s.name}</span></td>
                          <td style={{ padding: "4px 6px" }}>{s.rowCount}</td>
                          <td style={{ padding: "4px 6px", color: "var(--fg-muted, #8a96ac)" }}>
                            {s.columnHeaders.slice(0, 10).join(" · ") || <em>no headers</em>}
                            {s.columnHeaders.length > 10 ? ` … +${s.columnHeaders.length - 10}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div style={{ color: "var(--rose, #f43f5e)", fontWeight: 600, marginBottom: 6 }}>
                ✗ Upload failed
              </div>
              <div style={{ fontSize: 13 }}>{result.error}</div>
              {result.externalUrl ? (
                <div style={{ marginTop: 8 }}>
                  <a href={result.externalUrl} target="_blank" rel="noopener noreferrer">
                    {result.externalUrl} →
                  </a>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </main>
  );
}
