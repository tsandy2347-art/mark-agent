// POST /api/sources/trigger-run — kick off a specialist's main run now.
//
// Used by the upload hub's "Run now" button after a successful upload so
// Tony can see the new findings in his own brief without waiting for the
// cron cycle. Basic-auth gated by proxy.ts; the basic-auth username is
// forwarded to the specialist via x-triggered-by so the audit trail
// captures the actual human, not "agent:mark".
//
// Body: { specialist: "payroll-labour" }
//   (only payroll-labour today; will grow as Phase 1B adds more agents)

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED: Record<string, "SPECIALIST_PAYROLL_LABOUR_URL"> = {
  "payroll-labour": "SPECIALIST_PAYROLL_LABOUR_URL",
};

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
  const body = (await req.json().catch(() => ({}))) as { specialist?: unknown };
  const key = typeof body.specialist === "string" ? body.specialist : "";
  const envKey = ALLOWED[key];
  if (!envKey) {
    return NextResponse.json(
      { ok: false, error: `unknown specialist '${key}' (allowed: ${Object.keys(ALLOWED).join(", ")})` },
      { status: 400 },
    );
  }
  const baseUrl = env[envKey];
  if (!baseUrl) {
    return NextResponse.json(
      { ok: false, error: `${envKey} not configured on Mark` },
      { status: 500 },
    );
  }
  if (!env.HUB_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "HUB_API_KEY not configured on Mark" },
      { status: 500 },
    );
  }

  const me = (await currentUsername()) ?? "anonymous";
  const triggeredBy = `user:${me}`;

  const url = `${baseUrl.replace(/\/$/, "")}/api/cron/run`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HUB_API_KEY}`,
        "x-triggered-by": triggeredBy,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `failed to reach ${key}: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
  const json = await resp.json().catch(() => ({}));
  return NextResponse.json(
    { triggeredBy, target: key, ...json },
    { status: resp.status },
  );
}
