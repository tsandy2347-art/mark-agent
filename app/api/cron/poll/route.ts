// POST /api/cron/poll — Mark sweeps all 7 specialists and updates local cache.
//
// Auth: Bearer CRON_SECRET. The cron sidecar fires this every N minutes;
// MARK_MOCK=true short-circuits to canned fixtures so the pipeline is
// exercisable before any specialist is wired.

import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { pollAll } from "@/lib/mark/poll";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorised(req: NextRequest): boolean {
  if (!env.CRON_SECRET) return true; // unset = open in dev
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${env.CRON_SECRET}`;
}

export async function POST(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }
  const results = await pollAll();
  const ok = results.every((r) => r.ok);
  return NextResponse.json({ ok, results });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
