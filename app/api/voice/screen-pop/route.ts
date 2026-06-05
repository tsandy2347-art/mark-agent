// GET /api/voice/screen-pop — browser polls this every ~800ms during a voice
// call. Returns { key } when Mark has emitted a fresh marker since the
// previous poll; otherwise { key: null }.

import { NextResponse } from "next/server";
import { takeScreenPop } from "@/lib/voice-screen-pop";

export const dynamic = "force-dynamic";

export async function GET() {
  // Voice traffic is single-session (mark-voice-tony). If we ever split per
  // caller we'd take the session id from a query param; for now there's one.
  const pop = await takeScreenPop("mark-voice-tony");
  return NextResponse.json({ ok: true, key: pop?.key ?? null, at: pop?.at ?? null });
}
