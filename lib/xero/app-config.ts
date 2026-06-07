// Central config for the Xero apps we know how to talk to.
//
// "app" is a logical label (e.g. "pulse"). Each app has its own client ID,
// client secret, redirect URI, and scope set. Multiple Xero tenants (SC, CQ)
// can be authorised under one app via a single OAuth flow — Xero issues one
// refresh token per (app, user-consent) regardless of how many tenants the
// user picks.
//
// Env vars (one set per app):
//   XERO_PULSE_CLIENT_ID
//   XERO_PULSE_CLIENT_SECRET
//   XERO_PULSE_REDIRECT_URI   (full URL, e.g. https://mark-agent-production.up.railway.app/api/xero/callback)
//
// Scopes are the union of what the seven specialists need. Read-only —
// every "accounting.*" scope here is .read.

export type XeroAppKey = "pulse" | "legacy-fleet";

export interface XeroAppConfig {
  key: XeroAppKey;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

const FLEET_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access", // gives us the refresh_token — without this we'd lose access in 30 min
  "accounting.transactions.read",      // Rex (bank movements), Archie (bills), Vera (invoices), Monty (invoices)
  "accounting.journals.read",          // Rex (GL journals), Flora (manual journals)
  "accounting.contacts.read",          // every specialist (customer/supplier master)
  "accounting.settings.read",          // chart of accounts, tax rates, currencies, branding
  "accounting.reports.read",           // P&L, balance sheet, trial balance, bank summary, aged receivables
  "accounting.attachments.read",       // for evidence packs
];

export function getXeroAppConfig(app: XeroAppKey): XeroAppConfig {
  const upper = app.toUpperCase().replace("-", "_");
  const clientId = process.env[`XERO_${upper}_CLIENT_ID`];
  const clientSecret = process.env[`XERO_${upper}_CLIENT_SECRET`];
  const redirectUri = process.env[`XERO_${upper}_REDIRECT_URI`];

  const missing: string[] = [];
  if (!clientId) missing.push(`XERO_${upper}_CLIENT_ID`);
  if (!clientSecret) missing.push(`XERO_${upper}_CLIENT_SECRET`);
  if (!redirectUri) missing.push(`XERO_${upper}_REDIRECT_URI`);
  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }

  return {
    key: app,
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    scopes: FLEET_SCOPES,
  };
}
