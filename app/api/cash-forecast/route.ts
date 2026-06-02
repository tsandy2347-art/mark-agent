// POST /api/cash-forecast — save a new 13-week cash forecast input snapshot.
//
// Basic auth is enforced upstream by proxy.ts. We decode the header only to
// stamp `savedBy` for the audit trail. Append-only: each save is a new row,
// the page reads the newest by asOfDate.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function currentPeer(): Promise<string> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth?.startsWith("Basic ")) return "anonymous";
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    return decoded.split(":")[0].toLowerCase() || "anonymous";
  } catch {
    return "anonymous";
  }
}

// Coerce an incoming JSON value to a finite number, defaulting to 0.
function n(v: unknown): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

const FIELDS = [
  "westpacBalance",
  "stGeorgeBalance",
  "otherCashBalance",
  "ndiaOutstanding",
  "planManagerOutstanding",
  "selfManagedOutstanding",
  "hospitalsOutstanding",
  "privateOutstanding",
  "sahReceiptsMonthly",
  "apOpenBalance",
  "apWeeklyRun",
  "atoArrearsBalance",
  "atoMonthlyPaymentPlan",
  "weeklyPayrollGross",
  "weeklyEmployerSuper",
  "weeklyPaygSc",
  "monthlyPaygCq",
  "minimumBalanceAlert",
] as const;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const data: Record<string, number | string | Date> = {};
  for (const f of FIELDS) data[f] = n(body[f]);

  // minimumBalanceAlert: keep the 500k default if not supplied / zero.
  if (n(body.minimumBalanceAlert) === 0) data.minimumBalanceAlert = 500000;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  data.asOfDate = today;
  data.notes = typeof body.notes === "string" ? body.notes : "";
  data.savedBy = await currentPeer();

  const row = await prisma.cashForecastInput.create({
    data: data as never,
    select: { id: true, asOfDate: true, savedBy: true },
  });

  return NextResponse.json({ ok: true, saved: row });
}
