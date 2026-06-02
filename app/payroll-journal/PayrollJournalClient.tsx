// Payroll journal upload — Mark's deterministic MYOB → Craig-pattern preview.
// Drop the three MYOB xlsx exports, run the exact parser, review the SC + CQ
// journals (balanced DR/CR) + the PAYG amounts before any posting.

"use client";

import { useState, useCallback } from "react";

interface JournalLine {
  AccountCode?: string;
  AccountID?: string;
  LineAmount: number;
  Description: string;
}

interface TenantResult {
  lines: JournalLine[];
  total_dr: number;
  total_cr: number;
  payg: number;
  super_sg: number;
  net_pay: number;
  narration: string | null;
}

interface ParserResult {
  ok: boolean;
  meta: {
    pay_period_from: string;
    pay_period_to: string;
    journal_date: string;
    sc_runs: string[];
    cq_runs: string[];
  };
  sc: TenantResult | null;
  cq: TenantResult | null;
  totals: { payg_combined: number; super_combined: number; net_combined: number };
  posted?: {
    sc: { ManualJournalID?: string; xero_link?: string; TotalDR?: number; error?: string } | null;
    cq: { ManualJournalID?: string; xero_link?: string; TotalDR?: number; error?: string } | null;
  };
}

type FileKey = "summary" | "data" | "detail";

const FILE_HINTS: Record<FileKey, { label: string; nudge: string }> = {
  summary: { label: "1. Pay Activity Summary", nudge: "Gross / PAYG / super by branch." },
  data: { label: "2. Pay Activity Detail Data", nudge: "Flat table. Decline the 1000-row cap on export." },
  detail: { label: "3. Pay Activity Detail Report", nudge: "Per-line GL + sub-account. Source of truth." },
};

const aud = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2 });

export function PayrollJournalClient() {
  const [files, setFiles] = useState<Record<FileKey, File | null>>({ summary: null, data: null, detail: null });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ParserResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState<ParserResult | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  const allPresent = files.summary && files.data && files.detail;

  async function runPreview() {
    if (!allPresent) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setUploadId(null);
    setPostResult(null);
    setPostError(null);
    try {
      const fd = new FormData();
      fd.append("summary", files.summary!);
      fd.append("data", files.data!);
      fd.append("detail", files.detail!);
      const res = await fetch("/api/payroll-journal", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResult(json.result as ParserResult);
      setUploadId(json.uploadId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function postDraft() {
    if (!uploadId) return;
    setPosting(true);
    setPostError(null);
    setPostResult(null);
    try {
      const res = await fetch("/api/payroll-journal/post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPostResult(json.result as ParserResult);
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  function reset() {
    setFiles({ summary: null, data: null, detail: null });
    setResult(null);
    setError(null);
    setUploadId(null);
    setPostResult(null);
    setPostError(null);
  }

  return (
    <main className="container">
      <h1>Payroll journal</h1>
      <p className="muted">
        Drop the three MYOB exports and Mark builds the SC + CQ journals exactly as Craig did —
        same files in, same journal out, every time. Review the balanced lines and the PAYG
        amounts here. Posting the DRAFT to Xero is the next step (kept separate so nothing hits
        Xero until you&apos;ve checked the numbers).
      </p>

      {/* PAYG amounts — one card per ATO entity (SC and CQ are separate obligations) */}
      {result?.ok && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, margin: "16px 0" }}>
          {result.sc && (
            <div className="card">
              <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>
                SC + WB · Sunshine Coast · Large Withholder
              </div>
              <div style={{ fontSize: 12, marginTop: 8 }}>PAYG to remit</div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>{aud(result.sc.payg)}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Week ending {result.meta.pay_period_to} · PRN 501614548607470
              </div>
            </div>
          )}
          {result.cq && (
            <div className="card">
              <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>
                CQ · Just Better Care CQ · separate entity
              </div>
              <div style={{ fontSize: 12, marginTop: 8 }}>PAYG to remit</div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>{aud(result.cq.payg)}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Week ending {result.meta.pay_period_to}
              </div>
            </div>
          )}
        </div>
      )}

      {/* File pickers */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>MYOB exports</h2>
        <p className="muted" style={{ fontSize: 12 }}>All three .xlsx files required. Drag &amp; drop or click to browse.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 12 }}>
          {(Object.keys(FILE_HINTS) as FileKey[]).map((key) => (
            <FileDrop
              key={key}
              label={FILE_HINTS[key].label}
              nudge={FILE_HINTS[key].nudge}
              file={files[key]}
              onChange={(f) => setFiles((prev) => ({ ...prev, [key]: f }))}
            />
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="btn btn-primary" onClick={runPreview} disabled={!allPresent || loading}>
            {loading ? "Building journals…" : "Preview journals"}
          </button>
          <button className="btn" onClick={reset} disabled={loading}>Reset</button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: "var(--rose, #f43f5e)" }}>
          <span className="mono" style={{ fontSize: 13, color: "var(--rose, #f43f5e)" }}>{error}</span>
        </div>
      )}

      {/* Meta */}
      {result?.ok && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, fontSize: 13 }}>
            <div><div className="muted" style={{ fontSize: 12 }}>Pay period</div>{result.meta.pay_period_from} → {result.meta.pay_period_to}</div>
            <div><div className="muted" style={{ fontSize: 12 }}>Journal date</div>{result.meta.journal_date}</div>
            <div><div className="muted" style={{ fontSize: 12 }}>SC runs</div><span className="mono" style={{ fontSize: 12 }}>{result.meta.sc_runs.join(", ") || "—"}</span></div>
            <div><div className="muted" style={{ fontSize: 12 }}>CQ runs</div><span className="mono" style={{ fontSize: 12 }}>{result.meta.cq_runs.join(", ") || "—"}</span></div>
          </div>
        </div>
      )}

      {/* Journals */}
      {result?.sc && <JournalTable title="Sunshine Coast Pty Ltd (SC + Wide Bay)" result={result.sc} />}
      {result?.cq && <JournalTable title="Just Better Care CQ Pty Ltd" result={result.cq} />}

      {/* Post-to-Xero step — only after a successful preview, and not if already posted */}
      {result?.ok && uploadId && !postResult && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Create the draft in Xero</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            This creates the journals above as <strong>DRAFTS</strong> in Xero (SC and CQ). Nothing is
            posted to your live books or the ATO — a person still opens Xero and posts the draft the
            normal way. The draft is built by the exact same parser you just previewed.
          </p>
          <button className="btn btn-primary" onClick={postDraft} disabled={posting}>
            {posting ? "Creating drafts in Xero…" : "Create DRAFTs in Xero"}
          </button>
          {postError && (
            <div style={{ marginTop: 10, color: "var(--rose, #f43f5e)", fontSize: 13 }} className="mono">
              {postError}
            </div>
          )}
        </div>
      )}

      {/* Posted result — Xero draft links */}
      {postResult && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--emerald, #34d399)" }}>
          <h2 style={{ marginTop: 0, color: "var(--emerald, #34d399)" }}>✓ Drafts created in Xero</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Open each in Xero to review and post. (Draft only — not yet posted to your books.)
          </p>
          {(["sc", "cq"] as const).map((t) => {
            const posted = postResult.posted?.[t] as
              | { ManualJournalID?: string; xero_link?: string; TotalDR?: number; error?: string }
              | null;
            if (!posted) return null;
            const label = t === "sc" ? "SC + Wide Bay" : "CQ";
            if (posted.error) {
              return (
                <div key={t} style={{ fontSize: 13, marginTop: 6, color: "var(--rose, #f43f5e)" }}>
                  <strong>{label}:</strong> {posted.error}
                </div>
              );
            }
            return (
              <div key={t} style={{ fontSize: 13, marginTop: 6 }}>
                <strong>{label}:</strong>{" "}
                {posted.TotalDR != null ? aud(posted.TotalDR) + " · " : ""}
                {posted.xero_link ? (
                  <a href={posted.xero_link} target="_blank" rel="noopener noreferrer">Open in Xero →</a>
                ) : (
                  <span className="mono">{posted.ManualJournalID}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

function JournalTable({ title, result }: { title: string; result: TenantResult }) {
  const balanced = Math.abs(result.total_dr - result.total_cr) < 0.01;
  return (
    <div className="card" style={{ marginBottom: 16, padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "12px 14px" }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="mono" style={{ fontSize: 13 }}>
          DR {aud(result.total_dr)} / CR {aud(result.total_cr)}{" "}
          <span style={{ color: balanced ? "var(--emerald, #34d399)" : "var(--rose, #f43f5e)" }}>
            {balanced ? "✓ balanced" : "✗ unbalanced"}
          </span>
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Acct</th>
            <th>Description</th>
            <th style={{ textAlign: "right" }}>Debit</th>
            <th style={{ textAlign: "right" }}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {result.lines.map((line, i) => {
            const isDr = line.LineAmount > 0;
            return (
              <tr key={i}>
                <td className="mono">{line.AccountCode || (line.AccountID ? "877" : "?")}</td>
                <td>{line.Description}</td>
                <td className="mono" style={{ textAlign: "right" }}>{isDr ? aud(line.LineAmount) : ""}</td>
                <td className="mono" style={{ textAlign: "right" }}>{!isDr ? aud(-line.LineAmount) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FileDrop({
  label,
  nudge,
  file,
  onChange,
}: {
  label: string;
  nudge: string;
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputId = `drop-${label.replace(/\W+/g, "-").toLowerCase()}`;

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      setDragOver(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped && dropped.name.toLowerCase().endsWith(".xlsx")) onChange(dropped);
    },
    [onChange],
  );

  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{
        display: "block",
        cursor: "pointer",
        border: "2px dashed",
        borderColor: dragOver
          ? "var(--amber, #f59e0b)"
          : file
            ? "var(--emerald, #34d399)"
            : "var(--border, #cbd5e1)",
        borderRadius: 10,
        background: dragOver
          ? "rgba(245,158,11,0.08)"
          : file
            ? "rgba(52,211,153,0.08)"
            : "rgba(148,163,184,0.05)",
        padding: "22px 16px",
        minHeight: 120,
        transition: "all 0.15s",
      }}
    >
      <input
        id={inputId}
        type="file"
        accept=".xlsx"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{label}</div>
      {file ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--emerald, #34d399)", fontSize: 18 }}>✓</span>
          <span style={{ fontSize: 13, wordBreak: "break-all" }}>{file.name}</span>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onChange(null);
            }}
            style={{ marginLeft: "auto", background: "transparent", border: "none", cursor: "pointer", fontSize: 16, color: "var(--fg-muted, #94a3b8)" }}
            aria-label="Remove file"
          >
            ✕
          </button>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 28, opacity: 0.4, marginBottom: 6 }}>⬆</div>
          <div className="muted" style={{ fontSize: 12 }}>{nudge}</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6, opacity: 0.7 }}>
            Drag &amp; drop or click to browse
          </div>
        </>
      )}
    </label>
  );
}
