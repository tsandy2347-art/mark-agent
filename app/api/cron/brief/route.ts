// POST /api/cron/brief — builds + delivers one of the four briefs.
//
// Body: { briefType: "daily" | "restricted" | "weekly" | "monthly" }
// Auth: Bearer CRON_SECRET.
//
// The Railway cron sidecars hit this with the appropriate type on their own
// schedules (daily / weekly / monthly). The restricted brief is built every
// daily run — see scripts/build-brief.ts and lib/mark/brief.ts: if there's
// nothing restricted, the send is skipped (the channel guard fires only on
// the people-restricted recipient list).

import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { buildBrief, type BriefType } from "@/lib/mark/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorised(req: NextRequest): boolean {
  if (!env.CRON_SECRET) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${env.CRON_SECRET}`;
}

function parseBriefType(s: unknown): BriefType | null {
  if (s === "daily" || s === "restricted" || s === "weekly" || s === "monthly") return s;
  return null;
}

export async function POST(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { briefType?: unknown };
  const briefType = parseBriefType(body.briefType) ?? parseBriefType(req.nextUrl.searchParams.get("briefType"));
  if (!briefType) {
    return NextResponse.json({ ok: false, error: "briefType required (daily | restricted | weekly | monthly)" }, { status: 400 });
  }
  try {
    const result = await buildBrief(briefType);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
