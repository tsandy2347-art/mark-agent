// /api/xero/callback — Xero redirects here after the user clicks Authorise.
//
// We:
//   1. Validate the state cookie matches what Xero returned (CSRF protection)
//   2. Exchange the auth code for an access + refresh token
//   3. Call /connections to discover which tenant(s) this token can talk to
//   4. Upsert a XeroTenantToken row per tenant
//   5. Redirect the browser to /specialists with a success flash
//
// Bypassed in proxy.ts so Xero can reach it without basic-auth.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getXeroAppConfig, type XeroAppKey } from "@/lib/xero/app-config";

export const dynamic = "force-dynamic";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface Connection {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
  createdDateUtc: string;
}

function entityCodeFromName(name: string): string | null {
  const n = (name || "").toLowerCase();
  if (n.includes("sunshine coast")) return "SC";
  // Xero shows the CQ entity as "Just Better Care CQ Pty Ltd" — match on the
  // " cq " token (with spaces so we don't accidentally match e.g. "acquired").
  if (n.includes("central queensland") || / cq /.test(` ${n} `) || n.includes("cq pty")) return "CQ";
  return null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error");

  if (error) {
    return htmlError(`Xero rejected the connection: ${error}`);
  }
  if (!code) {
    return htmlError("Xero callback hit without an auth code.");
  }

  const expectedState = req.cookies.get("xero_oauth_state")?.value;
  if (!expectedState || expectedState !== returnedState) {
    return htmlError(
      "State mismatch — this callback didn't originate from a session we started. " +
      "Hit /api/xero/connect from this browser to start a fresh flow.",
    );
  }

  const app = expectedState.split(":")[0] as XeroAppKey;
  let cfg;
  try {
    cfg = getXeroAppConfig(app);
  } catch (e) {
    return htmlError((e as Error).message);
  }

  // 1. Exchange code for tokens.
  const tokRes = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
    }),
  });
  if (!tokRes.ok) {
    const body = await tokRes.text();
    return htmlError(`Token exchange failed: ${tokRes.status} ${body}`);
  }
  const tok = (await tokRes.json()) as TokenResponse;
  const expiresAt = new Date(Date.now() + tok.expires_in * 1000);

  // 2. Discover tenants this access token covers.
  const connRes = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!connRes.ok) {
    const body = await connRes.text();
    return htmlError(`Tenant discovery failed: ${connRes.status} ${body}`);
  }
  const conns = (await connRes.json()) as Connection[];

  if (!conns.length) {
    return htmlError(
      "Token granted but no Xero organisations are linked to it. " +
      "Re-run Authorise and pick at least one organisation.",
    );
  }

  // 3. Upsert one row per (xeroApp, tenantId). All tenants share the same
  //    access+refresh token pair on a Xero "connection".
  const upserted: { tenantName: string; entityCode: string | null }[] = [];
  for (const c of conns) {
    const entityCode = entityCodeFromName(c.tenantName);
    await prisma.xeroTenantToken.upsert({
      where: { xeroApp_tenantId: { xeroApp: app, tenantId: c.tenantId } },
      create: {
        xeroApp: app,
        tenantId: c.tenantId,
        tenantName: c.tenantName,
        entityCode,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt,
        scope: tok.scope,
        lastRefreshAt: new Date(),
      },
      update: {
        tenantName: c.tenantName,
        entityCode,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt,
        scope: tok.scope,
        lastRefreshAt: new Date(),
      },
    });
    upserted.push({ tenantName: c.tenantName, entityCode });
  }

  // 4. Wipe the state cookie + show success page.
  const res = new NextResponse(htmlSuccess(app, upserted, tok.scope), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  res.cookies.set("xero_oauth_state", "", { maxAge: 0, path: "/" });
  return res;
}

function htmlError(msg: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><body style="font-family:system-ui;background:#0a0f1a;color:#e8eef7;padding:40px;max-width:720px;margin:0 auto">
<h1 style="color:#f43f5e">Xero connection failed</h1>
<p style="font-family:monospace;background:#0f1623;padding:14px;border:1px solid #2a3447;border-radius:8px">${escapeHtml(msg)}</p>
<p><a href="/api/xero/connect?app=pulse" style="color:#22d3ee">Try again</a></p>
</body></html>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function htmlSuccess(
  app: string,
  tenants: { tenantName: string; entityCode: string | null }[],
  scope: string,
): string {
  const rows = tenants
    .map(
      (t) => `<li><strong>${escapeHtml(t.tenantName)}</strong>${
        t.entityCode ? ` <span style="color:#8a96ac">→ ${t.entityCode}</span>` : ""
      }</li>`,
    )
    .join("");
  return `<!doctype html><html><body style="font-family:system-ui;background:#0a0f1a;color:#e8eef7;padding:40px;max-width:720px;margin:0 auto">
<h1 style="color:#34d399">Xero connected ✓</h1>
<p>App: <code>${escapeHtml(app)}</code></p>
<p>Tenants linked:</p>
<ul>${rows}</ul>
<details style="margin-top:14px"><summary style="cursor:pointer;color:#8a96ac">Scopes granted</summary>
<pre style="background:#0f1623;padding:14px;border:1px solid #2a3447;border-radius:8px;white-space:pre-wrap;word-break:break-all">${escapeHtml(scope)}</pre></details>
<p style="margin-top:24px"><a href="/specialists" style="color:#22d3ee">Back to the dashboard</a></p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
