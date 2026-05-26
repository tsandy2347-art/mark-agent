// POST /api/qa — Mark's natural-language Q&A endpoint. Basic-auth via proxy.ts.
//
// Body (application/json):
//   {
//     question:  string,                          // can be "" on the very first
//                                                 // turn when PDFs are attached
//                                                 // (we'll use a default prompt)
//     history?:  Array<{ role: "user"|"assistant", text: string }>,
//                                                 // prior turns, oldest first
//     pdfs?:     Array<{ filename: string, base64: string }>,
//                                                 // one or more attached docs;
//                                                 // browser holds the base64
//                                                 // across turns and re-sends
//                                                 // (the Anthropic API is
//                                                 // stateless).
//     pdf?:      { filename: string, base64: string }
//                                                 // legacy alias for pdfs[0]
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
import type { QaHistoryTurn, QaPdf } from "@/lib/anthropic";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_PDF_BYTES = 30 * 1024 * 1024;          // 30 MB per PDF (Anthropic accepts up to 32)
const MAX_TOTAL_PDF_BYTES = 80 * 1024 * 1024;    // 80 MB total per request
const MAX_HISTORY_TURNS = 40;                     // cap the conversation we replay
const MAX_BODY_CHARS = 110 * 1024 * 1024;        // soft cap on incoming JSON

const DEFAULT_PDF_QUESTION =
  "I've attached PDFs. Read them carefully and tell me what you make of them. " +
  "Surface anything relevant to JBC finance — risks, opportunities, things " +
  "that contradict the data the specialists have already reported, anything " +
  "worth a human's attention. When quoting a figure or claim, name the file " +
  "it came from. Same rules: only use figures actually in the documents or " +
  "the data — don't invent.";

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

function parseOnePdf(raw: unknown):
  | { ok: true; pdf: QaPdf }
  | { ok: false; error: string } {
  if (typeof raw !== "object" || raw == null) {
    return { ok: false, error: "pdf entry must be an object" };
  }
  const r = raw as { filename?: unknown; base64?: unknown };
  if (typeof r.filename !== "string" || typeof r.base64 !== "string") {
    return { ok: false, error: "pdf entry needs { filename, base64 }" };
  }
  const approx = approxBytesFromBase64(r.base64);
  if (approx > MAX_PDF_BYTES) {
    return {
      ok: false,
      error: `PDF "${r.filename}" too large (~${(approx / 1_048_576).toFixed(1)} MB, max 30 MB per file)`,
    };
  }
  return { ok: true, pdf: { filename: r.filename.slice(0, 200), base64: r.base64 } };
}

function parsePdfs(rawPdfs: unknown, rawPdf: unknown):
  | { ok: true; pdfs: QaPdf[] }
  | { ok: false; error: string } {
  const entries: unknown[] = Array.isArray(rawPdfs)
    ? rawPdfs
    : rawPdf != null
      ? [rawPdf]
      : [];
  if (entries.length === 0) return { ok: true, pdfs: [] };
  const out: QaPdf[] = [];
  let totalApprox = 0;
  for (const e of entries) {
    const r = parseOnePdf(e);
    if (!r.ok) return r;
    out.push(r.pdf);
    totalApprox += approxBytesFromBase64(r.pdf.base64);
    if (totalApprox > MAX_TOTAL_PDF_BYTES) {
      return {
        ok: false,
        error: `Attached PDFs total ${(totalApprox / 1_048_576).toFixed(1)} MB — max ${(MAX_TOTAL_PDF_BYTES / 1_048_576).toFixed(0)} MB per request`,
      };
    }
  }
  return { ok: true, pdfs: out };
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
    pdfs?: unknown;
    pdf?: unknown;
  };

  const q = typeof body.question === "string" ? body.question.trim() : "";
  const history = parseHistory(body.history);
  const pdfRes = parsePdfs(body.pdfs, body.pdf);
  if (!pdfRes.ok) {
    return NextResponse.json({ ok: false, error: pdfRes.error }, { status: 400 });
  }
  const pdfs = pdfRes.pdfs;

  if (!q && pdfs.length === 0 && history.length === 0) {
    return NextResponse.json(
      { ok: false, error: "question, file, or history required" },
      { status: 400 },
    );
  }

  // First turn with PDFs and no question → use the default prompt.
  // On follow-up turns, an empty question is an error.
  let effectiveQ = q;
  if (!effectiveQ) {
    if (history.length === 0 && pdfs.length > 0) {
      effectiveQ = DEFAULT_PDF_QUESTION;
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
    pdfs,
    history,
  });
  return NextResponse.json({ ok: true, ...out });
}
