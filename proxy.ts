// HTTP Basic-auth gate.
//
// Next.js 16+ calls this "proxy" (previously "middleware"). The exported
// function MUST be named `proxy` — `middleware` is silently dropped on this
// runtime even though the file convention remains supported.
//
// Protects the human-facing pages + read APIs with shared credentials. The
// /restricted page is further gated server-side to MARK_RESTRICTED_USERNAMES
// only (Tony + Lindsay for people; Tony + Nicole for pay).
//
// Bypass paths (handle their own auth):
//   - /api/healthz       (Railway healthcheck)
//   - /api/cron/*        (Bearer CRON_SECRET)
//   - /_next/*, /favicon (static assets)

import { NextResponse, type NextRequest } from "next/server";

const BYPASS_PREFIXES = [
  "/api/healthz",
  "/api/cron/",
  "/api/voice/", // Vapi Custom-LLM — self-authed via Bearer VOICE_API_KEY
  "/api/xero/callback", // Xero OAuth redirects here — must be publicly reachable
  "/_next/",
  "/favicon",
];

function acceptedAuthHeaders(): string[] {
  const accepted: string[] = [];

  const u = process.env.BASIC_AUTH_USER;
  const p = process.env.BASIC_AUTH_PASS;
  if (u && p) {
    accepted.push("Basic " + Buffer.from(`${u}:${p}`).toString("base64"));
  }

  const multi = process.env.BASIC_AUTH_USERS;
  if (multi) {
    for (const pair of multi.split(",")) {
      const [user, ...rest] = pair.trim().split(":");
      const pass = rest.join(":");
      if (user && pass) {
        accepted.push("Basic " + Buffer.from(`${user}:${pass}`).toString("base64"));
      }
    }
  }

  return accepted;
}

export function proxy(req: NextRequest) {
  const accepted = acceptedAuthHeaders();
  if (accepted.length === 0) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (BYPASS_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const header = req.headers.get("authorization") ?? "";
  if (accepted.includes(header)) return NextResponse.next();

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      // NOTE: every char in the realm string MUST be ASCII (0-255). The Headers
      // Web API enforces ByteString here — a U+2014 em-dash or similar Unicode
      // will throw "Cannot convert argument to a ByteString" and we'll return
      // 500 instead of 401. Use plain hyphens.
      "WWW-Authenticate": 'Basic realm="Mark - JBC Finance Manager", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
