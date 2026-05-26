// POST /api/qa — Mark's natural-language Q&A endpoint. Basic-auth via proxy.ts.
//
// Accepts two content types:
//   - application/json with { question: string }
//   - multipart/form-data with `question` (text field, may be empty) and an
//     optional `file` field (PDF). When the PDF is present, it's forwarded to
//     Anthropic as a document content block — Mark reads it natively.
//
// Caller's Basic-auth username is used as `askedBy` for the audit log.
//
// Restricted findings (people / individual pay) are included in the data
// Mark consults ONLY when the caller is in MARK_RESTRICTED_USERNAMES.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { restrictedUsernames } from "@/lib/env";
import { askMark } from "@/lib/mark/qa";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB (Anthropic accepts up to 32)

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

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  let q = "";
  let pdf: { filename: string; base64: string } | undefined;

  if (ct.startsWith("multipart/form-data")) {
    const form = await req.formData();
    q = String(form.get("question") ?? "").trim();
    const file = form.get("file");
    if (file && typeof file !== "string" && file.size > 0) {
      if (file.type && file.type !== "application/pdf") {
        return NextResponse.json(
          { ok: false, error: `Only PDF uploads accepted (got ${file.type})` },
          { status: 400 },
        );
      }
      if (file.size > MAX_PDF_BYTES) {
        return NextResponse.json(
          { ok: false, error: `PDF too large (${(file.size / 1_048_576).toFixed(1)} MB, max 30 MB)` },
          { status: 400 },
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      pdf = {
        filename: (file.name || "uploaded.pdf").slice(0, 200),
        base64: Buffer.from(bytes).toString("base64"),
      };
    }
  } else {
    const body = (await req.json().catch(() => ({}))) as { question?: unknown };
    q = typeof body.question === "string" ? body.question.trim() : "";
  }

  if (!q && !pdf) {
    return NextResponse.json(
      { ok: false, error: "question or file required" },
      { status: 400 },
    );
  }

  // PDF-only upload → use a sensible default prompt so the model has a task.
  const effectiveQ = q || DEFAULT_PDF_QUESTION;

  const me = (await currentUsername()) ?? "anonymous";
  const canSeeRestricted = restrictedUsernames().includes(me);
  const out = await askMark({
    askedBy: me,
    question: effectiveQ,
    includeRestricted: canSeeRestricted,
    pdf,
  });
  return NextResponse.json({ ok: true, ...out });
}
