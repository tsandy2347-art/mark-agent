// GET /api/cash-forecast/pull — fetch live cash inputs from Xero.
//
// Mark holds NO Xero keys (by design). The read-only pull runs on the
// payroll-poster box (where the SC + CQ Xero keys already live) at its
// /cash-inputs endpoint. This route is a thin authenticated proxy: it forwards
// to the poster with the shared bearer, and hands the numbers back to the page.
//
// Returns, per tenant: bank accounts (auto-classified cash/card/restricted +
// a sensible include default), money owed split into the 7 debtor types, and
// total bills owed. The page merges these into the editable forecast state.

import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  if (!env.PAYROLL_POSTER_URL || !env.PAYROLL_POSTER_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "Xero pull is not wired up yet (poster URL/key missing)." },
      { status: 503 },
    );
  }

  const base = env.PAYROLL_POSTER_URL.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/cash-inputs?tenant=both`, {
      headers: { Authorization: `Bearer ${env.PAYROLL_POSTER_API_KEY}` },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; tenants?: unknown; error?: string }
      | null;
    if (!res.ok || !data?.ok) {
      return NextResponse.json(
        { ok: false, error: data?.error || `Xero pull failed (${res.status}).` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, tenants: data.tenants });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Could not reach the Xero reader: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
