// /qa — chat-style Q&A panel with PDF support and multi-turn follow-ups.
//
// Conversation state lives entirely in the browser:
//   - turns:        rendered Q/A history
//   - attachedPdf:  { name, base64 } that persists across turns until cleared.
//                   We read the file to base64 once when picked, then re-send
//                   the bytes in every POST (the Anthropic API is stateless,
//                   so each follow-up needs the document block again).
//
// "Clear conversation" wipes turns + the attached PDF; "Remove PDF" leaves
// the conversation but detaches the document so further turns are text-only.

"use client";

import { useRef, useState } from "react";

interface Turn {
  question: string;
  answer: string;
  dataAsOf: string;
  /** Set on the first turn of a conversation that included a PDF, for display. */
  pdfName?: string;
}

interface AttachedPdf {
  name: string;
  size: number;
  base64: string;
}

const MAX_PDF_BYTES = 30 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string"));
        return;
      }
      // data URL → strip "data:application/pdf;base64,"
      const i = result.indexOf(",");
      resolve(i >= 0 ? result.slice(i + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

export default function QaPage() {
  const [question, setQuestion] = useState("");
  const [attachedPdf, setAttachedPdf] = useState<AttachedPdf | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) return;
    if (f.type && f.type !== "application/pdf") {
      setError(`Only PDF files are accepted (got ${f.type}).`);
      return;
    }
    if (f.size > MAX_PDF_BYTES) {
      setError(`PDF too large (${(f.size / 1_048_576).toFixed(1)} MB, max 30 MB).`);
      return;
    }
    setError(null);
    try {
      const base64 = await fileToBase64(f);
      setAttachedPdf({ name: f.name, size: f.size, base64 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function clearFile() {
    setAttachedPdf(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function clearConversation() {
    setTurns([]);
    setAttachedPdf(null);
    setQuestion("");
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function ask() {
    const q = question.trim();
    if (!q && (turns.length > 0 || !attachedPdf)) {
      // No question on a follow-up turn (or with no PDF on the first turn).
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
      if (attachedPdf) {
        payload.pdf = { filename: attachedPdf.name, base64: attachedPdf.base64 };
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
        q || `(uploaded ${attachedPdf?.name} with no question — Mark used his default prompt)`;
      // Tag the first turn of the conversation with the PDF name so the
      // rendered history shows where the document entered.
      const isFirstTurn = turns.length === 0;
      setTurns((prev) => [
        ...prev,
        {
          question: turnQuestion,
          answer: String(json.answer),
          dataAsOf: String(json.dataAsOf),
          pdfName: isFirstTurn && attachedPdf ? attachedPdf.name : undefined,
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
    loading ||
    (!question.trim() && !(turns.length === 0 && attachedPdf));

  return (
    <main className="container">
      <h1>Ask Mark</h1>
      <p className="muted">
        Natural-language questions against current ingested data. You can attach a PDF —
        Mark reads it directly and reasons about it alongside the specialists' data. The
        PDF stays attached across follow-up turns until you remove it or clear the
        conversation. Same rules: he never invents figures; if he can't answer from
        what's in front of him, he says so.
      </p>

      <div className="card" style={{ marginTop: 12 }}>
        <label className="field-label" htmlFor="q">
          {inConversation ? "Follow-up" : "Question (optional if you attach a PDF)"}
        </label>
        <textarea
          id="q"
          rows={3}
          placeholder={
            inConversation
              ? "Drill in, push back, ask for the next angle…"
              : "e.g. What's CQ's cash position? What do you make of this invoice? Does this email change anything?"
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
            {loading ? "Asking..." : inConversation ? "Send follow-up" : attachedPdf ? "Ask Mark about this PDF" : "Ask"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={pickFile}
            disabled={loading}
            style={{ background: "transparent", border: "1px solid currentColor" }}
          >
            {attachedPdf ? "Replace PDF" : "Attach PDF"}
          </button>
          {attachedPdf ? (
            <span
              className="muted"
              style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              📎 {attachedPdf.name} ({(attachedPdf.size / 1024).toFixed(0)} KB) — stays attached
              <button
                type="button"
                onClick={clearFile}
                disabled={loading}
                style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 14 }}
                aria-label="Remove attached PDF"
                title="Remove PDF (conversation stays)"
              >
                ✕
              </button>
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              Cmd/Ctrl + Enter to send. PDF max 30 MB.
            </span>
          )}
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
              title="Start a fresh conversation (wipes history + PDF)"
            >
              Clear conversation
            </button>
          ) : null}
          {error ? <span style={{ color: "var(--rose)", fontSize: 12 }}>{error}</span> : null}
        </div>
      </div>

      <h2 style={{ marginTop: 22 }}>
        Conversation{inConversation ? ` (${turns.length} turn${turns.length === 1 ? "" : "s"})` : ""}
      </h2>
      {!inConversation ? (
        <div className="card" style={{ textAlign: "center", padding: 30 }}>
          <p className="muted" style={{ margin: 0 }}>No questions yet.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {turns.map((t, i) => (
            <div key={i} className="card">
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>
                You asked{t.pdfName ? ` (PDF: ${t.pdfName})` : ""}
              </div>
              <div style={{ marginBottom: 10 }}>{t.question}</div>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>Mark</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{t.answer}</div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
