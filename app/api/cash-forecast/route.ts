// POST /api/cash-forecast — save a cash forecast snapshot (both entities).
//
// Basic auth is enforced upstream by proxy.ts. We decode the header only to
// stamp `savedBy` for the audit trail. Append-only: each save is a new row,
// the page reads the newest by asOfDate. The whole forecast state (both
// entities + assumptions + cadences) is stored as one JSON blob.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import {
  DEBTOR_TYPES,
  type CashForecastState,
  type DebtorType,
  type EntityState,
  type TenantCode,
  emptyEntityState,
} from "@/lib/cash-forecast";

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

function num(v: unknown): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

// Defensively coerce one entity's worth of incoming JSON into a clean EntityState.
function cleanEntity(raw: unknown): EntityState {
  const base = emptyEntityState();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;

  const banks = Array.isArray(r.bankAccounts) ? r.bankAccounts : [];
  base.bankAccounts = banks.map((b) => {
    const bb = (b ?? {}) as Record<string, unknown>;
    const kind = bb.kind === "card" || bb.kind === "restricted" ? bb.kind : "cash";
    return {
      name: typeof bb.name === "string" ? bb.name : "(account)",
      balance: num(bb.balance),
      kind: kind as "cash" | "card" | "restricted",
      include: Boolean(bb.include),
    };
  });

  const ar = (r.ar ?? {}) as Record<string, unknown>;
  for (const t of DEBTOR_TYPES) base.ar[t as DebtorType] = num(ar[t]);

  base.apOpenBalance = num(r.apOpenBalance);

  const a = (r.assumptions ?? {}) as Record<string, unknown>;
  base.assumptions = {
    weeklyPayrollGross: num(a.weeklyPayrollGross),
    weeklyEmployerSuper: num(a.weeklyEmployerSuper),
    weeklyPaygSc: num(a.weeklyPaygSc),
    monthlyPaygCq: num(a.monthlyPaygCq),
    apWeeklyRun: num(a.apWeeklyRun),
    atoMonthlyPaymentPlan: num(a.atoMonthlyPaymentPlan),
    weeklyIncome: num(a.weeklyIncome),
  };
  return base;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cadenceRaw = (body.cadenceDays ?? {}) as Record<string, unknown>;
  const cadenceDays = {} as Record<DebtorType, number>;
  for (const t of DEBTOR_TYPES) {
    const v = num(cadenceRaw[t]);
    cadenceDays[t as DebtorType] = v > 0 ? v : 21;
  }

  const entitiesRaw = (body.entities ?? {}) as Record<string, unknown>;
  const state: CashForecastState = {
    asOfDate: today.toISOString().slice(0, 10),
    minimumBalanceAlert: num(body.minimumBalanceAlert) || 500000,
    cadenceDays,
    entities: {
      SC: cleanEntity(entitiesRaw.SC),
      CQ: cleanEntity(entitiesRaw.CQ),
    } as Record<TenantCode, EntityState>,
    notes: typeof body.notes === "string" ? body.notes : "",
    pulledAt: typeof body.pulledAt === "string" ? body.pulledAt : null,
  };

  const row = await prisma.cashForecastSnapshot.create({
    data: {
      asOfDate: today,
      state: state as unknown as object,
      notes: state.notes,
      savedBy: await currentPeer(),
    },
    select: { id: true, asOfDate: true, savedBy: true },
  });

  return NextResponse.json({ ok: true, saved: row });
}
