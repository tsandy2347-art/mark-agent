// Payroll journal upload — Mark's deterministic MYOB → Craig-pattern preview.
// Drop the three MYOB xlsx exports, run the exact parser, review the SC + CQ
// journals (balanced DR/CR) + the PAYG amounts before any posting.

"use client";

import { useState } from "react";

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

  const allPresent = files.summary && files.data && files.detail;

  async function runPreview() {
    if (!allPresent) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("summary", files.summary!);
      fd.append("data", files.data!);
      fd.append("detail", files.detail!);
      const res = await fetch("/api/payroll-journal", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResult(json.result as ParserResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setFiles({ summary: null, data: null, detail: null });
    setResult(null);
    setError(null);
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
        <p className="muted" style={{ fontSize: 12 }}>All three .xlsx files required.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 10 }}>
          {(Object.keys(FILE_HINTS) as FileKey[]).map((key) => (
            <div key={key}>
              <label className="field-label">{FILE_HINTS[key].label}</label>
              <input
                type="file"
                accept=".xlsx"
                onChange={(e) => setFiles((f) => ({ ...f, [key]: e.target.files?.[0] ?? null }))}
                style={{ width: "100%", fontSize: 12, marginTop: 4 }}
              />
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                {files[key] ? `✓ ${files[key]!.name}` : FILE_HINTS[key].nudge}
              </div>
            </div>
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
