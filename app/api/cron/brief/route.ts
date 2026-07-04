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
import { env, recipients } from "@/lib/env";
import { buildBrief, type BriefType } from "@/lib/mark/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorised(req: NextRequest): boolean {
  if (!env.CRON_SECRET) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${env.CRON_SECRET}`;
}

function parseBriefType(s: unknown): BriefType | null {
  if (s === "daily" || s === "recon-ar" || s === "restricted" || s === "weekly" || s === "monthly") return s;
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
    // Nicole's recon & receivables brief rides the daily trigger — one cron
    // sidecar, two emails. Skipped when no recipients are configured.
    let reconArResult = null;
    if (briefType === "daily" && recipients(env.MARK_RECON_AR_RECIPIENTS).length > 0) {
      reconArResult = await buildBrief("recon-ar").catch((e2) => ({
        error: e2 instanceof Error ? e2.message : String(e2),
      }));
    }
    return NextResponse.json({ ok: true, result, ...(reconArResult ? { reconAr: reconArResult } : {}) });
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
