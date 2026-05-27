// /journals/from-file — upload a file, Mark proposes journal lines via AI,
// human reviews/edits, recon creates the DRAFT in Xero (hard-locked).
//
// Two-step flow:
//   1. Upload spreadsheet + entity + (optional) hint.
//      Mark calls Anthropic with a tool-use prompt that constrains the
//      output to a balanced journal proposal. UI shows the proposal in an
//      editable form.
//   2. Human reviews/edits and clicks "Create DRAFT in Xero".
//      Mark forwards to recon's /api/journals/draft with Bearer HUB_API_KEY
//      + x-triggered-by header so the audit log captures the actual human.
//
// Status is hard-locked DRAFT inside recon — there's no path for Mark or
// the human-via-Mark to POST anything other than a draft.

"use client";

import { useRef, useState } from "react";

interface ProposedLine {
  amount: number;
  side: "DR" | "CR";
  accountCode: string;
  description?: string;
}

interface Proposal {
  narration: string;
  date: string;
  lines: ProposedLine[];
  rationale: string;
  totalDr: number;
  totalCr: number;
  balanced: boolean;
}

interface ProposeResult {
  ok: boolean;
  entity?: "SC" | "CQ";
  proposal?: Proposal;
  sourceFile?: { filename: string; byteSize: number; sheetCount: number; truncated: boolean };
  cannotPropose?: boolean;
  reason?: string;
  error?: string;
}

interface CreateResult {
  ok: boolean;
  manualJournalId?: string;
  xeroLink?: string;
  writeLogId?: string;
  triggeredBy?: string;
  error?: string;
}

const ACCEPT_ATTRIBUTE = [
  ".xlsx", ".xls", ".ods", ".csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
].join(",");

interface EditableLine {
  amount: string;
  side: "DR" | "CR";
  accountCode: string;
  description: string;
}

function proposalToEditable(p: Proposal): EditableLine[] {
  return p.lines.map((l) => ({
    amount: l.amount.toFixed(2),
    side: l.side,
    accountCode: l.accountCode,
    description: l.description ?? "",
  }));
}

export default function JournalFromFilePage() {
  const [entity, setEntity] = useState<"SC" | "CQ">("SC");
  const [hint, setHint] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [proposing, setProposing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [propose, setPropose] = useState<ProposeResult | null>(null);
  // Editable copy of the proposal so the human can fix amounts/codes.
  const [editLines, setEditLines] = useState<EditableLine[]>([]);
  const [editNarration, setEditNarration] = useState("");
  const [editDate, setEditDate] = useState("");
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function pickFile() {
    fileInputRef.current?.click();
  }
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setPropose(null);
    setCreateResult(null);
  }
  function resetAll() {
    setFile(null);
    setHint("");
    setPropose(null);
    setCreateResult(null);
    setEditLines([]);
    setEditNarration("");
    setEditDate("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function doPropose() {
    if (!file) return;
    setProposing(true);
    setPropose(null);
    setCreateResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("entity", entity);
      form.append("hint", hint);
      const res = await fetch("/api/journals/propose", { method: "POST", body: form });
      const json = (await res.json()) as ProposeResult;
      setPropose(json);
      if (json.ok && json.proposal) {
        setEditNarration(json.proposal.narration);
        setEditDate(json.proposal.date);
        setEditLines(proposalToEditable(json.proposal));
      }
    } catch (e) {
      setPropose({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setProposing(false);
    }
  }

  function setLine(idx: number, patch: Partial<EditableLine>) {
    setEditLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine(side: "DR" | "CR") {
    setEditLines((prev) => [...prev, { amount: "", side, accountCode: "", description: "" }]);
  }
  function removeLine(idx: number) {
    setEditLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== idx)));
  }

  const totalDr = editLines.filter((l) => l.side === "DR").reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const totalCr = editLines.filter((l) => l.side === "CR").reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const balanced = Math.abs(totalDr - totalCr) <= 0.01 && totalDr > 0;

  async function createDraft() {
    if (!balanced || !editNarration.trim()) return;
    setCreating(true);
    setCreateResult(null);
    try {
      const res = await fetch("/api/journals/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entity,
          narration: editNarration,
          date: editDate || undefined,
          lines: editLines.map((l) => ({
            amount: Number(l.amount),
            side: l.side,
            accountCode: l.accountCode.trim(),
            description: l.description.trim() || undefined,
          })),
        }),
      });
      const json = (await res.json()) as CreateResult;
      setCreateResult(json);
    } catch (e) {
      setCreateResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="container" style={{ maxWidth: 860 }}>
      <h1>Draft a journal from a file</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Upload a spreadsheet, tell Mark what kind of journal it is, and he'll
        propose balanced DR/CR lines for you to review. The proposal is editable
        before submission. On submit, the reconciliation agent creates the entry
        in Xero as <strong>DRAFT</strong>. A named human posts it in Xero the
        normal way — the agent never posts.
      </p>

      {/* Step 1: upload + propose */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>1. Upload</h2>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, alignItems: "end" }}>
          <div>
            <label className="field-label">Entity</label>
            <select value={entity} onChange={(e) => setEntity(e.target.value as "SC" | "CQ")} disabled={proposing || creating} style={{ width: "100%" }}>
              <option value="SC">SC</option>
              <option value="CQ">CQ</option>
            </select>
          </div>
          <div>
            <label className="field-label">What kind of journal? (optional hint)</label>
            <input
              type="text"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="e.g. June payroll accrual, depreciation, FX revaluation"
              disabled={proposing || creating}
              style={{ width: "100%" }}
            />
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            onChange={onFile}
            style={{ display: "none" }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              className="btn"
              onClick={pickFile}
              disabled={proposing || creating}
              style={{ background: "transparent", border: "1px solid currentColor" }}
            >
              {file ? "Replace file" : "Choose file"}
            </button>
            {file ? (
              <span className="muted" style={{ fontSize: 12 }}>
                📎 {file.name} ({(file.size / 1024).toFixed(0)} KB)
              </span>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>.xlsx / .xls / .ods / .csv · max 20 MB</span>
            )}
          </div>
        </div>

        <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
          <button className="btn btn-primary" onClick={doPropose} disabled={proposing || creating || !file}>
            {proposing ? "Mark is reading the file…" : "Propose journal"}
          </button>
          <button type="button" className="btn" onClick={resetAll} disabled={proposing || creating}>
            Reset
          </button>
        </div>

        {propose && !propose.ok ? (
          <div style={{ marginTop: 12, color: "var(--rose, #f43f5e)", fontSize: 13 }}>
            {propose.cannotPropose ? "Mark couldn't propose a journal: " : "Failed: "}
            {propose.reason ?? propose.error}
          </div>
        ) : null}
      </div>

      {/* Step 2: review + edit + create */}
      {propose?.ok && propose.proposal ? (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ marginTop: 0 }}>2. Review Mark's proposal</h2>
            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              <strong>Rationale (Mark):</strong> {propose.proposal.rationale}
            </div>

            <div style={{ marginTop: 8 }}>
              <label className="field-label" htmlFor="ed-nar">Narration</label>
              <textarea
                id="ed-nar"
                rows={2}
                value={editNarration}
                onChange={(e) => setEditNarration(e.target.value)}
                disabled={creating}
              />
            </div>

            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "160px 1fr", gap: 12 }}>
              <div>
                <label className="field-label">Date</label>
                <input
                  type="date"
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                  disabled={creating}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ alignSelf: "end" }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  Total DR: <strong style={{ color: balanced ? "var(--emerald, #34d399)" : "var(--rose, #f43f5e)" }}>${totalDr.toFixed(2)}</strong>
                  {" · "}
                  Total CR: <strong style={{ color: balanced ? "var(--emerald, #34d399)" : "var(--rose, #f43f5e)" }}>${totalCr.toFixed(2)}</strong>
                  {" "}
                  {balanced ? "✓ balanced" : "✗ unbalanced"}
                </span>
              </div>
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--fg-muted, #8a96ac)" }}>
                  <th style={{ padding: "6px 4px" }}>Side</th>
                  <th style={{ padding: "6px 4px" }}>Account code</th>
                  <th style={{ padding: "6px 4px", width: 110 }}>Amount</th>
                  <th style={{ padding: "6px 4px" }}>Description</th>
                  <th style={{ padding: "6px 4px", width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {editLines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ padding: "4px" }}>
                      <select value={l.side} onChange={(e) => setLine(i, { side: e.target.value as "DR" | "CR" })} disabled={creating}>
                        <option value="DR">DR</option>
                        <option value="CR">CR</option>
                      </select>
                    </td>
                    <td style={{ padding: "4px" }}>
                      <input
                        type="text"
                        value={l.accountCode}
                        onChange={(e) => setLine(i, { accountCode: e.target.value })}
                        style={{ width: "100%" }}
                        disabled={creating}
                      />
                    </td>
                    <td style={{ padding: "4px" }}>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={l.amount}
                        onChange={(e) => setLine(i, { amount: e.target.value })}
                        style={{ width: "100%", textAlign: "right" }}
                        disabled={creating}
                      />
                    </td>
                    <td style={{ padding: "4px" }}>
                      <input
                        type="text"
                        value={l.description}
                        onChange={(e) => setLine(i, { description: e.target.value })}
                        style={{ width: "100%" }}
                        disabled={creating}
                      />
                    </td>
                    <td style={{ padding: "4px", textAlign: "center" }}>
                      <button
                        type="button"
                        onClick={() => removeLine(i)}
                        disabled={creating || editLines.length <= 2}
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--fg-dim, #5a6478)" }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn" onClick={() => addLine("DR")} disabled={creating}>+ DR line</button>
              <button type="button" className="btn" onClick={() => addLine("CR")} disabled={creating}>+ CR line</button>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
              <button
                className="btn btn-primary"
                onClick={createDraft}
                disabled={creating || !balanced || !editNarration.trim()}
                title={!balanced ? "Total DR must equal total CR before creating" : ""}
              >
                {creating ? "Creating draft in Xero…" : "Create DRAFT in Xero"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                Posted as DRAFT only. A named human posts via Xero.
              </span>
            </div>
          </div>

          {createResult ? (
            <div className="card">
              {createResult.ok ? (
                <div>
                  <div style={{ color: "var(--emerald, #34d399)", fontWeight: 600, marginBottom: 6 }}>
                    ✓ Draft created in Xero
                  </div>
                  <div style={{ fontSize: 13, marginBottom: 8 }}>
                    ManualJournalID: <span className="mono">{createResult.manualJournalId}</span><br />
                    Triggered by: <span className="mono">{createResult.triggeredBy}</span><br />
                    Write log: <span className="mono">{createResult.writeLogId}</span>
                  </div>
                  {createResult.xeroLink ? (
                    <a href={createResult.xeroLink} target="_blank" rel="noopener noreferrer">Open in Xero →</a>
                  ) : null}
                </div>
              ) : (
                <div>
                  <div style={{ color: "var(--rose, #f43f5e)", fontWeight: 600, marginBottom: 6 }}>
                    ✗ Create failed
                  </div>
                  <div style={{ fontSize: 13 }}>{createResult.error}</div>
                </div>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
