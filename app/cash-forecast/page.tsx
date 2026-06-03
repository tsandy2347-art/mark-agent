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
import { CashForecastClient } from "./CashForecastClient";

export const dynamic = "force-dynamic";

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
