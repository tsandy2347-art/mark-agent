// POST /api/qa — Mark's natural-language Q&A endpoint. Basic-auth via proxy.ts.
//
// Body: { question: string }
// Caller's Basic-auth username is used as `askedBy` for the audit log.
//
// Restricted findings (people / individual pay) are included in the data
// Mark consults ONLY when the caller is in MARK_RESTRICTED_USERNAMES.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { restrictedUsernames } from "@/lib/env";
import { askMark } from "@/lib/mark/qa";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  const body = (await req.json().catch(() => ({}))) as { question?: unknown };
  const q = typeof body.question === "string" ? body.question.trim() : "";
  if (!q) {
    return NextResponse.json({ ok: false, error: "question required" }, { status: 400 });
  }
  const me = (await currentUsername()) ?? "anonymous";
  const canSeeRestricted = restrictedUsernames().includes(me);
  const out = await askMark({
    askedBy: me,
    question: q,
    includeRestricted: canSeeRestricted,
  });
  return NextResponse.json({ ok: true, ...out });
}
