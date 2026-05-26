// /qa — Mark's chat panel. Chat-bubble UI with sticky composer at top,
// conversation below newest-first (Tony's preference).
//
// Memory layer: Honcho session id in localStorage; "New conversation" mints
// a fresh thread (old one stays in Honcho for the deriver). Cross-session
// facts about the user are injected into the system prompt server-side.
//
// Attachments: PDFs / images (screenshots) / Excel / CSV — see /api/qa.

"use client";

import { useEffect, useRef, useState } from "react";

const SESSION_STORAGE_KEY = "mark-qa-session-id";

function newSessionId(): string {
  return `mark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadSessionId(): string {
  if (typeof window === "undefined") return newSessionId();
  try {
    const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  } catch {
    /* localStorage may be unavailable in some privacy modes — fall through. */
  }
  const fresh = newSessionId();
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, fresh);
  } catch {
    /* noop */
  }
  return fresh;
}

interface Turn {
  question: string;
  answer: string;
  dataAsOf: string;
  /** Filenames attached at the time of this turn (for the turn render). */
  attachmentNames?: string[];
}

interface Attachment {
  name: string;
  size: number;
  mimeType: string;
  base64: string;
}

type Category = "pdf" | "image" | "spreadsheet" | "csv";

const PDF_MIME = "application/pdf";
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
]);
const CSV_MIMES = new Set(["text/csv"]);

const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 110 * 1024 * 1024;

const ACCEPT_ATTRIBUTE = [
  "application/pdf",
  ".pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  ".xlsx",
  ".xls",
  ".ods",
  ".csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
].join(",");

function categoryOf(mime: string, filename = ""): Category | null {
  const m = mime.toLowerCase();
  if (m === PDF_MIME) return "pdf";
  if (IMAGE_MIMES.has(m)) return "image";
  if (SPREADSHEET_MIMES.has(m)) return "spreadsheet";
  if (CSV_MIMES.has(m)) return "csv";
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["xlsx", "xls", "ods"].includes(ext)) return "spreadsheet";
  if (ext === "csv") return "csv";
  return null;
}

function effectiveMime(mime: string, filename: string): string {
  if (mime) return mime;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf": return "application/pdf";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xls": return "application/vnd.ms-excel";
    case "ods": return "application/vnd.oasis.opendocument.spreadsheet";
    case "csv": return "text/csv";
    default: return "";
  }
}

function maxBytesFor(cat: Category): number {
  switch (cat) {
    case "pdf": return MAX_PDF_BYTES;
    case "image": return MAX_IMAGE_BYTES;
    case "spreadsheet":
    case "csv": return MAX_SPREADSHEET_BYTES;
  }
}

function iconFor(cat: Category | null): string {
  switch (cat) {
    case "pdf": return "📄";
    case "image": return "🖼";
    case "spreadsheet": return "📊";
    case "csv": return "📋";
    default: return "📎";
  }
}

function fileToBase64(file: File | Blob): Promise<string> {
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

function fmtTime(iso: string): string {
  if (!iso || iso === "(restored from memory)") return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function QaPage() {
  const [question, setQuestion] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
  const [memoryStatus, setMemoryStatus] = useState<"loading" | "ready" | "disabled" | "errored">("loading");
  const [copiedTurn, setCopiedTurn] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Boot the session + hydrate from Honcho.
  useEffect(() => {
    const id = loadSessionId();
    setSessionId(id);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/qa/history?sessionId=${encodeURIComponent(id)}`);
        if (!res.ok) {
          setMemoryStatus("errored");
          return;
        }
        const json = await res.json();
        if (cancelled) return;
        if (json.disabled) {
          setMemoryStatus("disabled");
          return;
        }
        setMemoryStatus(json.errored ? "errored" : "ready");
        const rawTurns: Array<{ role: "user" | "assistant"; text: string; createdAt?: string | null }> =
          Array.isArray(json.turns) ? json.turns : [];
        const paired: Turn[] = [];
        for (let i = 0; i < rawTurns.length; i++) {
          const t = rawTurns[i];
          if (t.role === "user") {
            const next = rawTurns[i + 1];
            if (next && next.role === "assistant") {
              paired.push({
                question: t.text,
                answer: next.text,
                dataAsOf: next.createdAt ?? "(restored from memory)",
              });
              i++;
            }
          }
        }
        setTurns(paired);
      } catch {
        if (!cancelled) setMemoryStatus("errored");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function addFiles(rawFiles: File[]) {
    if (rawFiles.length === 0) return;
    setError(null);
    const toAdd: Attachment[] = [];
    for (const f of rawFiles) {
      const mime = effectiveMime(f.type, f.name);
      const cat = categoryOf(mime, f.name);
      if (!cat) {
        setError(`Unsupported file: ${f.name} (${f.type || "unknown"}). Accept: PDF, PNG/JPEG/GIF/WebP, Excel/CSV.`);
        continue;
      }
      const cap = maxBytesFor(cat);
      if (f.size > cap) {
        setError(`Skipped ${f.name} — too large (${(f.size / 1_048_576).toFixed(1)} MB, max ${(cap / 1_048_576).toFixed(0)} MB for ${cat}).`);
        continue;
      }
      try {
        const base64 = await fileToBase64(f);
        toAdd.push({ name: f.name, size: f.size, mimeType: mime, base64 });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (toAdd.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setAttachments((prev) => {
      const merged = [...prev, ...toAdd];
      const total = merged.reduce((s, p) => s + p.size, 0);
      if (total > MAX_TOTAL_BYTES) {
        setError(`Total ${(total / 1_048_576).toFixed(1)} MB > ${(MAX_TOTAL_BYTES / 1_048_576).toFixed(0)} MB cap — newest not added.`);
        const out: Attachment[] = [...prev];
        let running = out.reduce((s, p) => s + p.size, 0);
        for (const p of toAdd) {
          if (running + p.size <= MAX_TOTAL_BYTES) {
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

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    await addFiles(Array.from(e.target.files ?? []));
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          const ext = blob.type.split("/")[1] ?? "png";
          const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          imageFiles.push(new File([blob], `screenshot-${ts}.${ext}`, { type: blob.type }));
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      await addFiles(imageFiles);
      setFlash(`Attached ${imageFiles.length} pasted image${imageFiles.length === 1 ? "" : "s"}`);
      setTimeout(() => setFlash(null), 2500);
    }
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function clearAllAttachments() {
    setAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function newConversation() {
    setTurns([]);
    setAttachments([]);
    setQuestion("");
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    const fresh = newSessionId();
    setSessionId(fresh);
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, fresh);
    } catch {
      /* noop */
    }
    textareaRef.current?.focus();
  }

  async function copyAnswer(idx: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTurn(idx);
      setTimeout(() => setCopiedTurn(null), 1500);
    } catch {
      /* clipboard API may be unavailable */
    }
  }

  async function ask() {
    const q = question.trim();
    const isFirstTurn = turns.length === 0;
    if (!q && !(isFirstTurn && attachments.length > 0)) return;

    setLoading(true);
    setError(null);
    try {
      const history = turns.flatMap((t) => [
        { role: "user" as const, text: t.question },
        { role: "assistant" as const, text: t.answer },
      ]);
      const payload: Record<string, unknown> = { question: q, history };
      if (attachments.length > 0) {
        payload.attachments = attachments.map((a) => ({
          filename: a.name,
          mimeType: a.mimeType,
          base64: a.base64,
        }));
      }
      if (sessionId) payload.sessionId = sessionId;

      const res = await fetch("/api/qa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

      if (typeof json.sessionId === "string" && json.sessionId && json.sessionId !== sessionId) {
        setSessionId(json.sessionId);
        try {
          window.localStorage.setItem(SESSION_STORAGE_KEY, json.sessionId);
        } catch {
          /* noop */
        }
      }
      if (json.memory && typeof json.memory === "object") {
        if (json.memory.disabled) setMemoryStatus("disabled");
        else if (json.memory.errored) setMemoryStatus("errored");
        else setMemoryStatus("ready");
      }
      const turnQuestion =
        q ||
        `(attached ${attachments.length} file${attachments.length === 1 ? "" : "s"}, no question — Mark used the default prompt)`;
      setTurns((prev) => [
        ...prev,
        {
          question: turnQuestion,
          answer: String(json.answer),
          dataAsOf: String(json.dataAsOf),
          attachmentNames:
            isFirstTurn && attachments.length > 0 ? attachments.map((p) => p.name) : undefined,
        },
      ]);
      setQuestion("");
      textareaRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const inConversation = turns.length > 0;
  const askDisabled = loading || (!question.trim() && !(turns.length === 0 && attachments.length > 0));
  const totalKb = Math.round(attachments.reduce((s, p) => s + p.size, 0) / 1024);
  // Newest first — Tony's preference.
  const renderedTurns = [...turns].reverse();

  const memBadgeText: Record<typeof memoryStatus, string> = {
    loading: "🧠 loading memory…",
    ready: "🧠 memory on",
    disabled: "🧠 no memory",
    errored: "🧠 memory unreachable",
  } as const;

  return (
    <main className="chat-container">
      <div className="chat-header">
        <h1>Ask Mark</h1>
        <span
          className="chat-mem-badge"
          data-state={memoryStatus}
          title={
            memoryStatus === "ready"
              ? `Honcho session ${sessionId.slice(0, 22)}…`
              : memoryStatus === "disabled"
                ? "Honcho not configured — this session won't persist."
                : memoryStatus === "errored"
                  ? "Honcho unreachable — answering without recall."
                  : "Loading memory layer…"
          }
        >
          {memBadgeText[memoryStatus]}
        </span>
        {inConversation ? (
          <button
            type="button"
            className="chat-iconbtn"
            onClick={newConversation}
            disabled={loading}
            style={{ marginLeft: "auto" }}
            title="Start a fresh conversation (the old thread stays in Mark's memory)"
          >
            + New conversation
          </button>
        ) : null}
      </div>

      <div className="chat-composer">
        <textarea
          ref={textareaRef}
          rows={3}
          placeholder={
            inConversation
              ? "Follow up, push back, ask for detail…"
              : "Ask Mark anything — about cash, claims, payroll, tax, AR / AP. Attach a PDF / spreadsheet / screenshot, or paste a screenshot."
          }
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onPaste={onPaste}
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
          accept={ACCEPT_ATTRIBUTE}
          multiple
          onChange={onFile}
          style={{ display: "none" }}
        />

        {attachments.length > 0 ? (
          <div className="chat-attachments">
            <div className="chat-attachments-meta">
              <span>
                {attachments.length} attachment{attachments.length === 1 ? "" : "s"} · {totalKb} KB · stays attached across turns
              </span>
              <button type="button" onClick={clearAllAttachments} disabled={loading}>
                remove all
              </button>
            </div>
            {attachments.map((p, i) => {
              const cat = categoryOf(p.mimeType, p.name);
              return (
                <span key={`${p.name}-${i}`} className="att-chip">
                  <span>{iconFor(cat)}</span>
                  <span className="att-name" title={p.name}>{p.name}</span>
                  <span className="att-size">{(p.size / 1024).toFixed(0)}KB</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    disabled={loading}
                    aria-label={`Remove ${p.name}`}
                    title={`Remove ${p.name}`}
                  >
                    ✕
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}

        <div className="chat-actions">
          <button className="chat-send" onClick={ask} disabled={askDisabled}>
            {loading ? "Asking…" : inConversation ? "Send" : "Ask Mark"}
          </button>
          <button type="button" className="chat-iconbtn" onClick={pickFile} disabled={loading}>
            📎 {attachments.length > 0 ? "Add more" : "Attach"}
          </button>
          <span className="chat-hint">⌘↵ to send · paste a screenshot</span>
        </div>

        {flash ? <div className="chat-banner flash">{flash}</div> : null}
        {error ? <div className="chat-banner error">{error}</div> : null}
      </div>

      <div className="chat-thread">
        {loading ? (
          <div className="chat-row mark">
            <div className="chat-avatar mark">M</div>
            <div className="chat-thinking">
              <span className="dots">
                <span></span>
                <span></span>
                <span></span>
              </span>
              <span>Mark is reading the latest specialist data…</span>
            </div>
          </div>
        ) : null}

        {!inConversation && !loading ? (
          <div className="chat-empty">
            <div className="big">💬</div>
            <div>No conversation yet.</div>
            <div className="chat-hint" style={{ marginTop: 6 }}>
              Ask a question, drop a document, or paste a screenshot to get started.
            </div>
          </div>
        ) : null}

        {renderedTurns.map((t, i) => {
          const originalIdx = turns.length - 1 - i; // index in oldest-first store
          const turnNumber = turns.length - i;
          return (
            <div key={originalIdx}>
              <div className="chat-row user">
                <div className="chat-bubble user">
                  <div className="body">{t.question}</div>
                  {t.attachmentNames && t.attachmentNames.length > 0 ? (
                    <div className="chat-bubble-footer">
                      <span className="files">
                        📎 {t.attachmentNames.join(" · ")}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="chat-row mark" style={{ marginTop: 10 }}>
                <div className="chat-avatar mark">M</div>
                <div className="chat-bubble mark">
                  <div className="body">{t.answer}</div>
                  <div className="chat-bubble-footer">
                    <span>
                      turn {turnNumber}
                      {t.dataAsOf && t.dataAsOf !== "(restored from memory)" ? ` · ${fmtTime(t.dataAsOf)}` : " · restored"}
                    </span>
                    <button
                      type="button"
                      className="copy"
                      onClick={() => copyAnswer(originalIdx, t.answer)}
                      title="Copy Mark's reply"
                    >
                      {copiedTurn === originalIdx ? "copied" : "copy"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
