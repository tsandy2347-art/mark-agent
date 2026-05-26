// GET /api/qa/history?sessionId=<honcho-session-id>
//
// Returns the recorded turns of a Honcho session so the /qa page can rehydrate
// the conversation when the user returns. Basic-auth gated by proxy.ts.
//
// Shape:
//   { ok: true, sessionId, turns: Array<{ role, text, createdAt }>, disabled, errored }
//
// Returns ok:true with an empty turns[] when the session doesn't exist yet OR
// Honcho is unreachable — the page can boot either way, the user just sees a
// fresh thread.

import { NextResponse, type NextRequest } from "next/server";
import { fetchMarkMemory } from "@/lib/honcho";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

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

export async function GET(req: NextRequest) {
  const sessionId = (req.nextUrl.searchParams.get("sessionId") ?? "").trim();
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "sessionId required" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    return NextResponse.json(
      { ok: false, error: "sessionId must be 8-64 chars, alphanumeric / _ / - only" },
      { status: 400 },
    );
  }

  const me = (await currentUsername()) ?? "anonymous";
  const memory = await fetchMarkMemory({ sessionId, userPeer: me });

  return NextResponse.json({
    ok: true,
    sessionId,
    turns: memory.resume.map((t) => ({
      role: t.role,
      text: t.text,
      createdAt: t.createdAt,
    })),
    disabled: memory.disabled,
    errored: memory.errored,
  });
}
