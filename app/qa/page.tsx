// /qa — chat-style Q&A panel with multi-PDF support and multi-turn follow-ups.
//
// Conversation state lives entirely in the browser:
//   - turns:           rendered Q/A history (stored oldest-first, RENDERED
//                      newest-first — Tony's preference)
//   - attachedPdfs:    array of { name, size, base64 } that persists across
//                      turns until cleared. Each turn re-sends the bytes
//                      because the Anthropic API is stateless.

"use client";

import { useRef, useState } from "react";

interface Turn {
  question: string;
  answer: string;
  dataAsOf: string;
  /** Filenames of PDFs that were attached at the time of this turn (for the
   *  turn render — informational only). */
  pdfNames?: string[];
}

interface AttachedPdf {
  name: string;
  size: number;
  base64: string;
}

const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_PDF_BYTES = 80 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string"));
        return;
      }
      const i = result.indexOf(",");
      resolve(i >= 0 ? result.slice(i + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

export default function QaPage() {
  const [question, setQuestion] = useState("");
  const [attachedPdfs, setAttachedPdfs] = useState<AttachedPdf[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const fs = Array.from(e.target.files ?? []);
    if (fs.length === 0) return;
    setError(null);

    const toAdd: AttachedPdf[] = [];
    for (const f of fs) {
      if (f.type && f.type !== "application/pdf") {
        setError(`Only PDF files are accepted — skipped ${f.name} (${f.type}).`);
        continue;
      }
      if (f.size > MAX_PDF_BYTES) {
        setError(`Skipped ${f.name} — too large (${(f.size / 1_048_576).toFixed(1)} MB, max 30 MB per file).`);
        continue;
      }
      try {
        const base64 = await fileToBase64(f);
        toAdd.push({ name: f.name, size: f.size, base64 });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    if (toAdd.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setAttachedPdfs((prev) => {
      const merged = [...prev, ...toAdd];
      const total = merged.reduce((s, p) => s + p.size, 0);
      if (total > MAX_TOTAL_PDF_BYTES) {
        setError(
          `Total attached ${(total / 1_048_576).toFixed(1)} MB exceeds ${(MAX_TOTAL_PDF_BYTES / 1_048_576).toFixed(0)} MB cap — newest files not added.`,
        );
        // Add only as many as fit
        const out: AttachedPdf[] = [...prev];
        let running = out.reduce((s, p) => s + p.size, 0);
        for (const p of toAdd) {
          if (running + p.size <= MAX_TOTAL_PDF_BYTES) {
            out.push(p);
            running += p.size;
          }
        }
        return out;
      }
      return merged;
    });

    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removePdf(idx: number) {
    setAttachedPdfs((prev) => prev.filter((_, i) => i !== idx));
  }

  function clearAllPdfs() {
    setAttachedPdfs([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function clearConversation() {
    setTurns([]);
    setAttachedPdfs([]);
    setQuestion("");
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function ask() {
    const q = question.trim();
    const isFirstTurn = turns.length === 0;
    // First turn allowed PDF-only (no question); follow-ups require a question.
    if (!q && !(isFirstTurn && attachedPdfs.length > 0)) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const history = turns.flatMap((t) => [
        { role: "user" as const, text: t.question },
        { role: "assistant" as const, text: t.answer },
      ]);
      const payload: Record<string, unknown> = {
        question: q,
        history,
      };
      if (attachedPdfs.length > 0) {
        payload.pdfs = attachedPdfs.map((p) => ({ filename: p.name, base64: p.base64 }));
      }
      const res = await fetch("/api/qa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const turnQuestion =
        q ||
        `(uploaded ${attachedPdfs.length} PDF${attachedPdfs.length === 1 ? "" : "s"} with no question — Mark used his default prompt)`;
      // Only the FIRST turn of the conversation needs the PDF-name annotation
      // (the same files persist across follow-ups; not worth repeating).
      setTurns((prev) => [
        ...prev,
        {
          question: turnQuestion,
          answer: String(json.answer),
          dataAsOf: String(json.dataAsOf),
          pdfNames: isFirstTurn && attachedPdfs.length > 0 ? attachedPdfs.map((p) => p.name) : undefined,
        },
      ]);
      setQuestion("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const inConversation = turns.length > 0;
  const askDisabled =
    loading || (!question.trim() && !(turns.length === 0 && attachedPdfs.length > 0));
  const totalPdfKb = Math.round(attachedPdfs.reduce((s, p) => s + p.size, 0) / 1024);
  // Render newest first (Tony's preference). Store stays oldest-first.
  const renderedTurns = [...turns].reverse();

  return (
    <main className="container">
      <h1>Ask Mark</h1>
      <p className="muted">
        Natural-language questions against current ingested data. You can attach one or
        more PDFs — Mark reads them directly and reasons about them alongside the
        specialists' data. Attached PDFs stay in the conversation across follow-up
        turns until you remove them or clear the conversation. Same rules: he never
        invents figures; if he can't answer from what's in front of him, he says so.
      </p>

      <div className="card" style={{ marginTop: 12 }}>
        <label className="field-label" htmlFor="q">
          {inConversation
            ? "Follow-up"
            : "Question (optional if you attach a PDF)"}
        </label>
        <textarea
          id="q"
          rows={3}
          placeholder={
            inConversation
              ? "Drill in, push back, ask for the next angle…"
              : "e.g. What's CQ's cash position? What do you make of these invoices? Does this email change anything?"
          }
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void ask();
            }
          }}
        />

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={onFile}
          style={{ display: "none" }}
        />

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button className="btn btn-primary" onClick={ask} disabled={askDisabled}>
            {loading
              ? "Asking..."
              : inConversation
                ? "Send follow-up"
                : attachedPdfs.length > 0
                  ? `Ask Mark about ${attachedPdfs.length} PDF${attachedPdfs.length === 1 ? "" : "s"}`
                  : "Ask"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={pickFile}
            disabled={loading}
            style={{ background: "transparent", border: "1px solid currentColor" }}
          >
            {attachedPdfs.length > 0 ? "Add more PDFs" : "Attach PDF(s)"}
          </button>
          {inConversation ? (
            <button
              type="button"
              className="btn"
              onClick={clearConversation}
              disabled={loading}
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "1px solid currentColor",
                fontSize: 12,
              }}
              title="Start a fresh conversation (wipes history + PDFs)"
            >
              Clear conversation
            </button>
          ) : null}
        </div>

        {attachedPdfs.length > 0 ? (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 6,
              border: "1px solid var(--surface-border, rgba(127,127,127,0.25))",
              background: "rgba(127,127,127,0.05)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <span className="muted" style={{ fontSize: 12 }}>
                Attached {attachedPdfs.length} PDF{attachedPdfs.length === 1 ? "" : "s"} ({totalPdfKb} KB total) — stays attached across turns
              </span>
              <button
                type="button"
                onClick={clearAllPdfs}
                disabled={loading}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  textDecoration: "underline",
                  color: "var(--rose, #c33)",
                }}
              >
                Remove all
              </button>
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {attachedPdfs.map((p, i) => (
                <li
                  key={`${p.name}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <span>📎</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {(p.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => removePdf(i)}
                    disabled={loading}
                    aria-label={`Remove ${p.name}`}
                    title={`Remove ${p.name}`}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 14,
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Cmd/Ctrl + Enter to send. Up to 30 MB per file, 80 MB total.
          </div>
        )}

        {error ? (
          <div style={{ color: "var(--rose, #c33)", fontSize: 12, marginTop: 8 }}>{error}</div>
        ) : null}
      </div>

      <h2 style={{ marginTop: 22 }}>
        Conversation
        {inConversation
          ? ` (${turns.length} turn${turns.length === 1 ? "" : "s"} — newest first)`
          : ""}
      </h2>
      {!inConversation ? (
        <div className="card" style={{ textAlign: "center", padding: 30 }}>
          <p className="muted" style={{ margin: 0 }}>No questions yet.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {renderedTurns.map((t, i) => {
            // Convert reversed index back to original turn number for the label
            const turnNumber = turns.length - i;
            return (
              <div key={turnNumber} className="card">
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>
                  Turn {turnNumber}{t.pdfNames && t.pdfNames.length > 0 ? ` — PDFs: ${t.pdfNames.join(", ")}` : ""}
                </div>
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2, marginTop: 6 }}>
                  You asked
                </div>
                <div style={{ marginBottom: 10 }}>{t.question}</div>
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>Mark</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{t.answer}</div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
