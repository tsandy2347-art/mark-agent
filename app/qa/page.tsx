// /qa — chat-style Q&A panel with multi-file attachments + multi-turn follow-ups.
//
// Accepted attachment types:
//   - PDF                          → Anthropic document content block (native)
//   - PNG / JPEG / GIF / WebP      → Anthropic image content block (native)
//   - Excel (.xlsx / .xls / .ods)  → server-side parsed to CSV text and
//                                    embedded in the prompt
//   - CSV                          → embedded as-is in the prompt
//
// Conversation state lives entirely in the browser:
//   - turns:        rendered Q/A history (stored oldest-first, rendered
//                   newest-first — Tony's preference)
//   - attachments:  array of { name, size, mimeType, base64 } that persists
//                   across turns until cleared. Browser re-sends the bytes on
//                   every follow-up (Anthropic API is stateless).
//
// Bonus: paste a screenshot directly into the textarea and it's added as an
// image attachment automatically (no need to save the file first).

"use client";

import { useRef, useState } from "react";

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
  // Fallback to extension sniffing — browsers don't always set mimeType.
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["xlsx", "xls", "ods"].includes(ext)) return "spreadsheet";
  if (ext === "csv") return "csv";
  return null;
}

function effectiveMime(mime: string, filename: string): string {
  // Browsers sometimes omit mimeType on drag/drop. Map from extension.
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
    case "image": return "🖼️";
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

export default function QaPage() {
  const [question, setQuestion] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        setError(`Unsupported file type: ${f.name} (${f.type || "unknown"}). Accepted: PDF, PNG/JPEG/GIF/WebP, Excel/CSV.`);
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
        setError(`Total attached ${(total / 1_048_576).toFixed(1)} MB exceeds ${(MAX_TOTAL_BYTES / 1_048_576).toFixed(0)} MB cap — newest files not added.`);
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

  /** Catch screenshots pasted into the textarea (Cmd+V after Cmd+Shift+4
   *  on macOS, PrtScn on Windows). */
  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          // Synthesize a filename — paste blobs have name === "" by default.
          const ext = blob.type.split("/")[1] ?? "png";
          const ts = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 19);
          const file = new File([blob], `screenshot-${ts}.${ext}`, { type: blob.type });
          imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      await addFiles(imageFiles);
      setFlash(`📎 Attached ${imageFiles.length} pasted image${imageFiles.length === 1 ? "" : "s"}`);
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

  function clearConversation() {
    setTurns([]);
    setAttachments([]);
    setQuestion("");
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
      const payload: Record<string, unknown> = {
        question: q,
        history,
      };
      if (attachments.length > 0) {
        payload.attachments = attachments.map((a) => ({
          filename: a.name,
          mimeType: a.mimeType,
          base64: a.base64,
        }));
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
        `(attached ${attachments.length} file${attachments.length === 1 ? "" : "s"} with no question — Mark used his default prompt)`;
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const inConversation = turns.length > 0;
  const askDisabled =
    loading || (!question.trim() && !(turns.length === 0 && attachments.length > 0));
  const totalKb = Math.round(attachments.reduce((s, p) => s + p.size, 0) / 1024);
  const renderedTurns = [...turns].reverse();

  return (
    <main className="container">
      <h1>Ask Mark</h1>
      <p className="muted">
        Natural-language questions against current ingested data. Attach PDFs,
        screenshots, Excel files (.xlsx/.xls/.ods/.csv) or paste a screenshot
        directly into the box below. Attachments stay in the conversation across
        follow-up turns until you remove them. Same rules: Mark never invents
        figures; if he can't answer from what's in front of him, he says so.
      </p>

      <div className="card" style={{ marginTop: 12 }}>
        <label className="field-label" htmlFor="q">
          {inConversation
            ? "Follow-up"
            : "Question (optional if you attach a file or paste a screenshot)"}
        </label>
        <textarea
          id="q"
          rows={3}
          placeholder={
            inConversation
              ? "Drill in, push back, ask for the next angle…"
              : "e.g. What's CQ's cash position? What do you make of this report? Does this email change anything?"
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
                : attachments.length > 0
                  ? `Ask Mark about ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`
                  : "Ask"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={pickFile}
            disabled={loading}
            style={{ background: "transparent", border: "1px solid currentColor" }}
          >
            {attachments.length > 0 ? "Add more files" : "Attach files"}
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
              title="Start a fresh conversation (wipes history + attachments)"
            >
              Clear conversation
            </button>
          ) : null}
        </div>

        {attachments.length > 0 ? (
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
                {attachments.length} attachment{attachments.length === 1 ? "" : "s"} ({totalKb} KB total) — stays attached across turns
              </span>
              <button
                type="button"
                onClick={clearAllAttachments}
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
              {attachments.map((p, i) => {
                const cat = categoryOf(p.mimeType, p.name);
                return (
                  <li
                    key={`${p.name}-${i}`}
                    style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
                  >
                    <span>{iconFor(cat)}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {cat ?? "file"} · {(p.size / 1024).toFixed(0)} KB
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      disabled={loading}
                      aria-label={`Remove ${p.name}`}
                      title={`Remove ${p.name}`}
                      style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 14 }}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Cmd/Ctrl + Enter to send. Paste a screenshot directly. PDF/Excel
            up to 30/10 MB, images up to 8 MB, 110 MB total.
          </div>
        )}

        {flash ? <div style={{ color: "var(--accent, #2a7)", fontSize: 12, marginTop: 8 }}>{flash}</div> : null}
        {error ? <div style={{ color: "var(--rose, #c33)", fontSize: 12, marginTop: 8 }}>{error}</div> : null}
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
            const turnNumber = turns.length - i;
            return (
              <div key={turnNumber} className="card">
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>
                  Turn {turnNumber}{t.attachmentNames && t.attachmentNames.length > 0 ? ` — Files: ${t.attachmentNames.join(", ")}` : ""}
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
