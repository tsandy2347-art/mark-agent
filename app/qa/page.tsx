// /qa — chat-style Q&A panel. Client component (uses local state for input +
// rendered conversation). POSTs to /api/qa which records every Q&A pair in
// FinanceQuery.

"use client";

import { useRef, useState } from "react";

interface Turn {
  question: string;
  answer: string;
  dataAsOf: string;
  pdfName?: string;
}

export default function QaPage() {
  const [question, setQuestion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function pickFile() {
    fileInputRef.current?.click();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f && f.type && f.type !== "application/pdf") {
      setError(`Only PDF files are accepted (got ${f.type}).`);
      return;
    }
    if (f && f.size > 30 * 1024 * 1024) {
      setError(`PDF too large (${(f.size / 1_048_576).toFixed(1)} MB, max 30 MB).`);
      return;
    }
    setError(null);
    setFile(f);
  }

  function clearFile() {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function ask() {
    const q = question.trim();
    if (!q && !file) return;
    setLoading(true);
    setError(null);
    try {
      let res: Response;
      if (file) {
        const fd = new FormData();
        fd.append("question", q);
        fd.append("file", file);
        res = await fetch("/api/qa", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/qa", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: q }),
        });
      }
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const turnQuestion = q || `(uploaded ${file?.name} with no question — Mark used his default prompt)`;
      setTurns((prev) => [
        ...prev,
        {
          question: turnQuestion,
          answer: String(json.answer),
          dataAsOf: String(json.dataAsOf),
          pdfName: file?.name,
        },
      ]);
      setQuestion("");
      clearFile();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>Ask Mark</h1>
      <p className="muted">
        Natural-language questions against current ingested data. You can also attach a PDF —
        Mark reads it directly and reasons about it alongside the specialists' data. Same rules
        apply: he never invents figures. If he can't answer from what's in front of him, he says so.
      </p>

      <div className="card" style={{ marginTop: 12 }}>
        <label className="field-label" htmlFor="q">Question (optional if you attach a PDF)</label>
        <textarea
          id="q"
          rows={3}
          placeholder="e.g. What's CQ's cash position? What do you make of this invoice? Does this email change anything?"
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
          <button
            className="btn btn-primary"
            onClick={ask}
            disabled={loading || (!question.trim() && !file)}
          >
            {loading ? "Asking..." : file ? "Ask Mark about this PDF" : "Ask"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={pickFile}
            disabled={loading}
            style={{ background: "transparent", border: "1px solid currentColor" }}
          >
            {file ? "Replace PDF" : "Attach PDF"}
          </button>
          {file ? (
            <span
              className="muted"
              style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {file.name} ({(file.size / 1024).toFixed(0)} KB)
              <button
                type="button"
                onClick={clearFile}
                disabled={loading}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 14,
                }}
                aria-label="Remove attached PDF"
              >
                ✕
              </button>
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              Cmd/Ctrl + Enter to send. PDF max 30 MB.
            </span>
          )}
          {error ? <span style={{ color: "var(--rose)", fontSize: 12 }}>{error}</span> : null}
        </div>
      </div>

      <h2 style={{ marginTop: 22 }}>Conversation</h2>
      {turns.length === 0 ? (
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
