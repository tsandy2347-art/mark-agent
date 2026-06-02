// /cash-forecast — Mark's 13-week cash view. Loads the latest typed-in input,
// computes the forecast on the fly, renders the editable form + week table.

import { prisma } from "@/lib/prisma";
import { buildForecast, inputRowToBuildArgs } from "@/lib/cash-forecast";
import { CashForecastClient, type FormValues } from "./CashForecastClient";

export const dynamic = "force-dynamic";

const ZERO_FORM: FormValues = {
  westpacBalance: 0,
  stGeorgeBalance: 0,
  otherCashBalance: 0,
  ndiaOutstanding: 0,
  planManagerOutstanding: 0,
  selfManagedOutstanding: 0,
  hospitalsOutstanding: 0,
  privateOutstanding: 0,
  sahReceiptsMonthly: 0,
  apOpenBalance: 0,
  apWeeklyRun: 0,
  atoArrearsBalance: 0,
  atoMonthlyPaymentPlan: 0,
  weeklyPayrollGross: 0,
  weeklyEmployerSuper: 0,
  weeklyPaygSc: 0,
  monthlyPaygCq: 0,
  minimumBalanceAlert: 500000,
  notes: "",
};

const dec = (v: { toString(): string }) => Number(v.toString());

export default async function CashForecastPage() {
  const latest = await prisma.cashForecastInput.findFirst({
    orderBy: { asOfDate: "desc" },
  });

  if (!latest) {
    return (
      <CashForecastClient
        initialForm={ZERO_FORM}
        initialForecast={null}
        hasInput={false}
        savedBy={null}
      />
    );
  }

  const forecast = buildForecast(inputRowToBuildArgs(latest));

  const initialForm: FormValues = {
    westpacBalance: dec(latest.westpacBalance),
    stGeorgeBalance: dec(latest.stGeorgeBalance),
    otherCashBalance: dec(latest.otherCashBalance),
    ndiaOutstanding: dec(latest.ndiaOutstanding),
    planManagerOutstanding: dec(latest.planManagerOutstanding),
    selfManagedOutstanding: dec(latest.selfManagedOutstanding),
    hospitalsOutstanding: dec(latest.hospitalsOutstanding),
    privateOutstanding: dec(latest.privateOutstanding),
    sahReceiptsMonthly: dec(latest.sahReceiptsMonthly),
    apOpenBalance: dec(latest.apOpenBalance),
    apWeeklyRun: dec(latest.apWeeklyRun),
    atoArrearsBalance: dec(latest.atoArrearsBalance),
    atoMonthlyPaymentPlan: dec(latest.atoMonthlyPaymentPlan),
    weeklyPayrollGross: dec(latest.weeklyPayrollGross),
    weeklyEmployerSuper: dec(latest.weeklyEmployerSuper),
    weeklyPaygSc: dec(latest.weeklyPaygSc),
    monthlyPaygCq: dec(latest.monthlyPaygCq),
    minimumBalanceAlert: dec(latest.minimumBalanceAlert),
    notes: latest.notes,
  };

  return (
    <CashForecastClient
      initialForm={initialForm}
      initialForecast={forecast}
      hasInput
      savedBy={latest.savedBy || null}
    />
  );
}
