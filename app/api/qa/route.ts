// POST /api/qa — Mark's natural-language Q&A endpoint. Basic-auth via proxy.ts.
//
// Body (application/json):
//   {
//     question:  string,                          // can be "" on the very first
//                                                 // turn when attachments are
//                                                 // present (default prompt
//                                                 // used).
//     history?:  Array<{ role: "user"|"assistant", text: string }>,
//                                                 // prior turns, oldest first
//     attachments?: Array<{
//                     filename: string,
//                     mimeType: string,
//                     base64: string
//                   }>
//                                                 // canonical multi-type
//                                                 // attachment field — PDF,
//                                                 // image (PNG/JPEG/GIF/WebP),
//                                                 // spreadsheet (xlsx / xls /
//                                                 // ods / csv). Browser
//                                                 // re-sends on every follow-up
//                                                 // (Anthropic API is
//                                                 // stateless).
//     pdfs?:     Array<{ filename, base64 }>      // legacy alias — treated as
//                                                 // application/pdf
//     pdf?:      { filename, base64 }             // legacy alias — pdfs[0]
//   }
//
// Caller's Basic-auth username is used as `askedBy` for the audit log.
//
// Restricted findings (people / individual pay) are included in the data
// Mark consults ONLY when the caller is in MARK_RESTRICTED_USERNAMES.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { restrictedUsernames } from "@/lib/env";
import { askMark } from "@/lib/mark/qa";
import type { QaAttachment, QaHistoryTurn } from "@/lib/anthropic";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Per-type caps. Anthropic limits: PDF 32MB, image ~5MB recommended.
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 110 * 1024 * 1024;       // total per request
const MAX_BODY_CHARS = 150 * 1024 * 1024;        // soft cap on incoming JSON
const MAX_HISTORY_TURNS = 40;

// Accepted mime types per category. Lowercase comparison.
const ACCEPTED_PDF = new Set(["application/pdf"]);
const ACCEPTED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ACCEPTED_SPREADSHEET = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel",                                          // .xls
  "application/vnd.oasis.opendocument.spreadsheet",                    // .ods
  "text/csv",
]);

const DEFAULT_ATTACHMENT_QUESTION =
  "I've attached one or more files. Read them carefully and tell me what " +
  "you make of them. Surface anything relevant to JBC finance — risks, " +
  "opportunities, things that contradict the data the specialists have " +
  "already reported, anything worth a human's attention. When quoting a " +
  "figure or claim, name the file it came from. Same rules: only use figures " +
  "actually in the attachments or the data — don't invent.";

async function currentUsername(): Promise<string | null> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    return decoded.split(":")[0].toLowerCase();
  } catch {
    return null;
  }
}

function parseHistory(raw: unknown): QaHistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: QaHistoryTurn[] = [];
  for (const t of raw.slice(0, MAX_HISTORY_TURNS)) {
    if (
      t &&
      typeof t === "object" &&
      "role" in t &&
      "text" in t &&
      (t.role === "user" || t.role === "assistant") &&
      typeof t.text === "string" &&
      t.text.trim()
    ) {
      out.push({ role: t.role, text: t.text });
    }
  }
  return out;
}

function approxBytesFromBase64(s: string): number {
  return Math.floor((s.length * 3) / 4);
}

function categoryFor(mime: string): "pdf" | "image" | "spreadsheet" | null {
  const m = mime.toLowerCase();
  if (ACCEPTED_PDF.has(m)) return "pdf";
  if (ACCEPTED_IMAGE.has(m)) return "image";
  if (ACCEPTED_SPREADSHEET.has(m)) return "spreadsheet";
  return null;
}

function capForCategory(c: "pdf" | "image" | "spreadsheet"): number {
  return c === "pdf" ? MAX_PDF_BYTES : c === "image" ? MAX_IMAGE_BYTES : MAX_SPREADSHEET_BYTES;
}

function labelForCategory(c: "pdf" | "image" | "spreadsheet"): string {
  return c === "pdf" ? "PDF" : c === "image" ? "image" : "spreadsheet";
}

function parseAttachment(raw: unknown, fallbackMime?: string):
  | { ok: true; attachment: QaAttachment }
  | { ok: false; error: string } {
  if (typeof raw !== "object" || raw == null) {
    return { ok: false, error: "attachment must be an object" };
  }
  const r = raw as { filename?: unknown; base64?: unknown; mimeType?: unknown };
  if (typeof r.filename !== "string" || typeof r.base64 !== "string") {
    return { ok: false, error: "attachment needs { filename, base64 }" };
  }
  const mime = typeof r.mimeType === "string" ? r.mimeType : fallbackMime ?? "";
  if (!mime) {
    return { ok: false, error: `attachment "${r.filename}" missing mimeType` };
  }
  const cat = categoryFor(mime);
  if (!cat) {
    return {
      ok: false,
      error: `attachment "${r.filename}" has unsupported mime type "${mime}" (accepted: PDF, PNG/JPEG/GIF/WebP, Excel/CSV)`,
    };
  }
  const approx = approxBytesFromBase64(r.base64);
  const cap = capForCategory(cat);
  if (approx > cap) {
    return {
      ok: false,
      error: `${labelForCategory(cat)} "${r.filename}" too large (~${(approx / 1_048_576).toFixed(1)} MB, max ${(cap / 1_048_576).toFixed(0)} MB)`,
    };
  }
  return {
    ok: true,
    attachment: {
      filename: r.filename.slice(0, 200),
      mimeType: mime.toLowerCase(),
      base64: r.base64,
    },
  };
}

function parseAttachments(
  rawAttachments: unknown,
  rawPdfs: unknown,
  rawPdf: unknown,
):
  | { ok: true; attachments: QaAttachment[] }
  | { ok: false; error: string } {
  const entries: Array<{ raw: unknown; fallbackMime?: string }> = [];
  if (Array.isArray(rawAttachments)) {
    for (const e of rawAttachments) entries.push({ raw: e });
  }
  if (Array.isArray(rawPdfs)) {
    for (const e of rawPdfs) entries.push({ raw: e, fallbackMime: "application/pdf" });
  }
  if (rawPdf != null && !Array.isArray(rawPdf)) {
    entries.push({ raw: rawPdf, fallbackMime: "application/pdf" });
  }
  if (entries.length === 0) return { ok: true, attachments: [] };
  const out: QaAttachment[] = [];
  let totalApprox = 0;
  for (const e of entries) {
    const r = parseAttachment(e.raw, e.fallbackMime);
    if (!r.ok) return r;
    out.push(r.attachment);
    totalApprox += approxBytesFromBase64(r.attachment.base64);
    if (totalApprox > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: `Total attachments ${(totalApprox / 1_048_576).toFixed(1)} MB — max ${(MAX_TOTAL_BYTES / 1_048_576).toFixed(0)} MB per request`,
      };
    }
  }
  return { ok: true, attachments: out };
}

export async function POST(req: NextRequest) {
  // Reject obviously oversized bodies fast.
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_CHARS) {
    return NextResponse.json({ ok: false, error: "request too large" }, { status: 413 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    question?: unknown;
    history?: unknown;
    attachments?: unknown;
    pdfs?: unknown;
    pdf?: unknown;
  };

  const q = typeof body.question === "string" ? body.question.trim() : "";
  const history = parseHistory(body.history);
  const attRes = parseAttachments(body.attachments, body.pdfs, body.pdf);
  if (!attRes.ok) {
    return NextResponse.json({ ok: false, error: attRes.error }, { status: 400 });
  }
  const attachments = attRes.attachments;

  if (!q && attachments.length === 0 && history.length === 0) {
    return NextResponse.json(
      { ok: false, error: "question, file, or history required" },
      { status: 400 },
    );
  }

  // First turn with attachments and no question → use the default prompt.
  // On follow-up turns, an empty question is an error.
  let effectiveQ = q;
  if (!effectiveQ) {
    if (history.length === 0 && attachments.length > 0) {
      effectiveQ = DEFAULT_ATTACHMENT_QUESTION;
    } else {
      return NextResponse.json(
        { ok: false, error: "question required for follow-up turns" },
        { status: 400 },
      );
    }
  }

  const me = (await currentUsername()) ?? "anonymous";
  const canSeeRestricted = restrictedUsernames().includes(me);
  const out = await askMark({
    askedBy: me,
    question: effectiveQ,
    includeRestricted: canSeeRestricted,
    attachments,
    history,
  });
  return NextResponse.json({ ok: true, ...out });
}
