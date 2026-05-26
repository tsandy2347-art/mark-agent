// /qa — chat-style Q&A panel. Client component (uses local state for input +
// rendered conversation). POSTs to /api/qa which records every Q&A pair in
// FinanceQuery.

"use client";

import { useState } from "react";

interface Turn {
  question: string;
  answer: string;
  dataAsOf: string;
}

export default function QaPage() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/qa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setTurns((prev) => [...prev, { question: q, answer: String(json.answer), dataAsOf: String(json.dataAsOf) }]);
      setQuestion("");
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
        Natural-language questions against current ingested data. Mark answers only from what the
        specialists have already reported. If he can't, he says so.
      </p>

      <div className="card" style={{ marginTop: 12 }}>
        <label className="field-label" htmlFor="q">Question</label>
        <textarea
          id="q"
          rows={3}
          placeholder="e.g. What's CQ's cash position? How much unclaimed revenue last month? Are we on track for the BAS?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
          <button className="btn btn-primary" onClick={ask} disabled={loading || !question.trim()}>
            {loading ? "Asking..." : "Ask"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>Cmd/Ctrl + Enter to send</span>
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
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>You asked</div>
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
