// POST /api/journals/create — forward a human-approved journal proposal to
// the reconciliation agent's draft endpoint.
//
// Browser flow: /journals/from-file uploads → /api/journals/propose returns
// proposal → user reviews/edits → this endpoint forwards to recon. Recon
// creates the DRAFT in Xero (status hard-locked) and returns the deep-link.
//
// Auth: Basic auth via Mark's proxy.ts. We forward to recon with Bearer
// HUB_API_KEY + x-triggered-by header (so recon's audit log captures the
// actual human who approved, not just "agent:mark").
//
// Body (application/json):
//   {
//     entity: "SC" | "CQ",
//     narration: string,
//     date?: "yyyy-mm-dd",
//     lines: [{ amount, side, accountCode, description? }],
//     lineAmountTypes?: "Exclusive" | "Inclusive" | "NoTax"
//   }
//
// Response: forwarded verbatim from recon (manualJournalId, xeroLink, etc.)

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { env } from "@/lib/env";

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
  const baseUrl = env.SPECIALIST_RECONCILIATION_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { ok: false, error: "SPECIALIST_RECONCILIATION_URL not configured on Mark" },
      { status: 500 },
    );
  }
  if (!env.HUB_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "HUB_API_KEY not configured on Mark" },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const me = (await currentUsername()) ?? "anonymous";
  const triggeredBy = `user:${me}`;

  const downstreamUrl = `${baseUrl.replace(/\/$/, "")}/api/journals/draft`;
  let resp: Response;
  try {
    resp = await fetch(downstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.HUB_API_KEY}`,
        "x-triggered-by": triggeredBy,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `failed to reach reconciliation agent: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const json = await resp.json().catch(() => ({}));
  return NextResponse.json(
    { triggeredBy, target: "reconciliation-agent", ...json },
    { status: resp.status },
  );
}
