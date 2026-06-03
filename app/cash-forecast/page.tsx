// /cash-forecast — Mark's 13-week cash view, REWORKED 2026-06.
//
// Loads the latest saved snapshot, computes SC + CQ + combined forecasts on the
// fly, and hands the editable state to the client. If there's no snapshot yet,
// it starts from a blank state (Tony clicks "Pull from Xero" to fill it).

import { prisma } from "@/lib/prisma";
import {
  buildForecast,
  emptyState,
  type CashForecastState,
} from "@/lib/cash-forecast";
import { env } from "@/lib/env";
import { CashForecastClient } from "./CashForecastClient";

export const dynamic = "force-dynamic";

// Pull this entity's typical weekly income live from the poster's /cash-inputs.
// Used to BACKFILL snapshots saved before the weeklyIncome field existed (those
// snapshots showed no money coming in, so the 13-week line drifted down). Best
// effort — if the poster is unreachable we just leave income as-is.
async function fetchWeeklyIncome(): Promise<{ SC: number; CQ: number } | null> {
  if (!env.PAYROLL_POSTER_URL || !env.PAYROLL_POSTER_API_KEY) return null;
  const base = env.PAYROLL_POSTER_URL.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/cash-inputs?tenant=both`, {
      headers: { Authorization: `Bearer ${env.PAYROLL_POSTER_API_KEY}` },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; tenants?: Record<string, { weeklyIncomeEstimate?: number }> }
      | null;
    if (!res.ok || !data?.ok || !data.tenants) return null;
    return {
      SC: Number(data.tenants.SC?.weeklyIncomeEstimate) || 0,
      CQ: Number(data.tenants.CQ?.weeklyIncomeEstimate) || 0,
    };
  } catch {
    return null;
  }
}

export default async function CashForecastPage() {
  const latest = await prisma.cashForecastSnapshot.findFirst({
    orderBy: { asOfDate: "desc" },
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString().slice(0, 10);

  let state: CashForecastState;
  let savedBy: string | null = null;
  let hasInput = false;

  if (latest) {
    // The stored JSON is the full state; refresh asOfDate to today so the
    // 13-week window always starts from now even on an older save.
    state = { ...(latest.state as unknown as CashForecastState), asOfDate: todayIso };
    savedBy = latest.savedBy || null;
    hasInput = true;

    // Self-heal: snapshots saved before the weeklyIncome field existed have no
    // ongoing income, so the forecast wrongly showed nothing coming in. If
    // either entity is missing a positive weeklyIncome, backfill it live from
    // Xero (via the poster) so the line is realistic without a manual re-pull.
    const sc = state.entities?.SC?.assumptions;
    const cq = state.entities?.CQ?.assumptions;
    const scMissing = !sc || !(Number(sc.weeklyIncome) > 0);
    const cqMissing = !cq || !(Number(cq.weeklyIncome) > 0);
    if (scMissing || cqMissing) {
      const income = await fetchWeeklyIncome();
      if (income) {
        if (sc && scMissing) sc.weeklyIncome = income.SC;
        if (cq && cqMissing) cq.weeklyIncome = income.CQ;
      }
    }
  } else {
    state = emptyState(todayIso);
  }

  const forecast = buildForecast(state);

  return (
    <CashForecastClient
      initialState={state}
      initialForecast={forecast}
      hasInput={hasInput}
      savedBy={savedBy}
    />
  );
}
