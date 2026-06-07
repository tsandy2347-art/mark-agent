// /api/xero/connect — kicks off the Xero OAuth flow.
//
// User hits this (basic-auth gated by proxy.ts), we generate a state nonce,
// stash it in a short-lived cookie, and redirect to Xero's authorise URL.
// Xero will redirect back to /api/xero/callback when the user approves.
//
// Query string controls which app config to use, e.g.
//   /api/xero/connect?app=pulse
// Defaults to "pulse" — the Pulse-owned 5,000/day Xero app whose credentials
// we mirrored into mark-agent env vars (XERO_PULSE_CLIENT_ID etc.).

import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { getXeroAppConfig, type XeroAppKey } from "@/lib/xero/app-config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const app = (url.searchParams.get("app") || "pulse") as XeroAppKey;

  let cfg;
  try {
    cfg = getXeroAppConfig(app);
  } catch (e) {
    return new NextResponse(
      `Xero app "${app}" is not configured — env vars missing. ${(e as Error).message}`,
      { status: 500 },
    );
  }

  // state is a one-time nonce that's checked in the callback. It binds the
  // browser session to the callback so an attacker can't replay an old code.
  const state = randomBytes(24).toString("base64url");

  const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("redirect_uri", cfg.redirectUri);
  authUrl.searchParams.set("scope", cfg.scopes.join(" "));
  authUrl.searchParams.set("state", `${app}:${state}`);

  const res = NextResponse.redirect(authUrl.toString(), { status: 302 });
  // Short-lived (10 min) httpOnly cookie carrying the state we expect back.
  res.cookies.set("xero_oauth_state", `${app}:${state}`, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
