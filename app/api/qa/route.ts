// POST /api/qa — Mark's natural-language Q&A endpoint. Basic-auth via proxy.ts.
//
// Body (application/json):
//   {
//     question:  string,                          // can be "" on the very first
//                                                 // turn when a PDF is attached
//                                                 // (we'll use a default prompt)
//     history?:  Array<{ role: "user"|"assistant", text: string }>,
//                                                 // prior turns, oldest first
//     pdf?:      { filename: string, base64: string }
//                                                 // browser reads the file once
//                                                 // and re-sends the base64 on
//                                                 // every follow-up turn — the
//                                                 // Anthropic API is stateless.
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
import type { QaHistoryTurn } from "@/lib/anthropic";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB (Anthropic accepts up to 32)
const MAX_HISTORY_TURNS = 40;          // cap the conversation we replay
const MAX_BODY_CHARS = 60 * 1024 * 1024; // soft cap on incoming JSON

const DEFAULT_PDF_QUESTION =
  "I've attached a PDF. Read it carefully and tell me what you make of it. " +
  "Surface anything that's relevant to JBC finance — risks, opportunities, " +
  "things that contradict the data the specialists have already reported, " +
  "anything worth a human's attention. Same rules: only use figures actually " +
  "in the document or the data — don't invent.";

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

function parsePdf(raw: unknown):
  | { ok: true; pdf: { filename: string; base64: string } | undefined }
  | { ok: false; error: string } {
  if (raw == null) return { ok: true, pdf: undefined };
  if (typeof raw !== "object") return { ok: false, error: "pdf must be an object" };
  const r = raw as { filename?: unknown; base64?: unknown };
  if (typeof r.filename !== "string" || typeof r.base64 !== "string") {
    return { ok: false, error: "pdf needs { filename, base64 }" };
  }
  // Rough size check: base64 ≈ bytes * 4 / 3
  const approxBytes = Math.floor((r.base64.length * 3) / 4);
  if (approxBytes > MAX_PDF_BYTES) {
    return {
      ok: false,
      error: `PDF too large (~${(approxBytes / 1_048_576).toFixed(1)} MB, max 30 MB)`,
    };
  }
  return {
    ok: true,
    pdf: { filename: r.filename.slice(0, 200), base64: r.base64 },
  };
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
    pdf?: unknown;
  };

  const q = typeof body.question === "string" ? body.question.trim() : "";
  const history = parseHistory(body.history);
  const pdfRes = parsePdf(body.pdf);
  if (!pdfRes.ok) {
    return NextResponse.json({ ok: false, error: pdfRes.error }, { status: 400 });
  }
  const pdf = pdfRes.pdf;

  if (!q && !pdf && history.length === 0) {
    return NextResponse.json(
      { ok: false, error: "question, file, or history required" },
      { status: 400 },
    );
  }

  // First turn with a PDF and no question → use the default prompt.
  // On follow-up turns, an empty question is an error.
  let effectiveQ = q;
  if (!effectiveQ) {
    if (history.length === 0 && pdf) {
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
    pdf,
    history,
  });
  return NextResponse.json({ ok: true, ...out });
}
