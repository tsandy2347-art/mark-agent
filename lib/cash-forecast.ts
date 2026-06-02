// 13-week rolling cash forecast — pure compute, no I/O.
//
// Honest model:
//  - Bank balance is the ANCHOR (Tony types it in). Xero BankSummary shows the
//    reconciled balance, not live cash, so it's wrong for forecasting.
//  - Money owed (AR) is timed by debtor TYPE, not Xero due dates (those are
//    ~useless for NDIS/SaH). Each pool lands `cadenceDays` from today.
//  - Outflows: weekly payroll + super (quarterly bursts) + PAYG (SC weekly,
//    CQ monthly) + AP (open settled over 2 wks + weekly run) + ATO plan.
//  - Output: per-week opening, inflows, outflows, net, closing; anything that
//    closes below `minimumBalanceAlert` is flagged.

import type { Prisma } from "./generated/prisma";

// AR collection cadence by debtor type — days until $1 outstanding lands in
// the bank. Bucketed, NOT exact dates.
const AR_CADENCE_DAYS = {
  ndia: 10,
  planManager: 30,
  selfManaged: 14,
  hospitals: 30,
  private: 21,
} as const;

// Quarterly super safe-lodgement dates (28th of month after quarter end).
// Covers the forecast horizon; update annually.
const SUPER_QUARTERLY_DUE_DATES_ISO = [
  "2026-04-28",
  "2026-07-28",
  "2026-10-28",
  "2027-01-28",
  "2027-04-28",
];

// CQ monthly PAYG due on the 21st of the following month (ATO standard).
function cqPaygDueDateForMonth(year: number, monthIndex: number): Date {
  let dueYear = year;
  let dueMonth = monthIndex + 1;
  if (dueMonth > 11) {
    dueMonth = 0;
    dueYear++;
  }
  return new Date(dueYear, dueMonth, 21);
}

export type ForecastWeek = {
  weekNumber: number;
  weekStarting: string;
  weekEnding: string;
  openingBalance: number;
  arNdia: number;
  arPlanManager: number;
  arSelfManaged: number;
  arHospitals: number;
  arPrivate: number;
  sahReceipts: number;
  totalInflows: number;
  payrollGross: number;
  paygScWeekly: number;
  paygCqMonthly: number;
  employerSuperQuarterly: number;
  apOutflow: number;
  atoPaymentPlan: number;
  totalOutflows: number;
  netFlow: number;
  closingBalance: number;
  belowMinimum: boolean;
  notes: string[];
};

export type ForecastResult = {
  asOfDate: string;
  startingCash: number;
  minimumBalanceAlert: number;
  weeks: ForecastWeek[];
  summary: {
    lowestWeek: ForecastWeek | null;
    lowestBalance: number;
    weeksBelowMinimum: number;
    totalInflows13w: number;
    totalOutflows13w: number;
    endingBalance: number;
  };
};

function startOfWeekMonday(d: Date): Date {
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function num(v: Prisma.Decimal | number): number {
  return typeof v === "number" ? v : Number(v.toString());
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Allocate an AR pool to the forecast week its cadence lands in. The whole
 * `outstanding` amount lands `cadenceDays` from today. Beyond week 13 = dropped
 * (acceptable v1 — enough to surface near-term crunches).
 */
function allocateArToWeeks(
  outstanding: number,
  cadenceDays: number,
  weekStartDates: Date[],
  today: Date,
): number[] {
  const out = new Array(weekStartDates.length).fill(0);
  if (outstanding <= 0) return out;
  const landing = new Date(today);
  landing.setDate(today.getDate() + cadenceDays);
  for (let i = 0; i < weekStartDates.length; i++) {
    const wkStart = weekStartDates[i];
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkStart.getDate() + 6);
    if (landing >= wkStart && landing <= wkEnd) {
      out[i] = outstanding;
      return out;
    }
  }
  return out; // beyond horizon — dropped
}

export type BuildForecastInput = {
  asOfDate: Date;
  westpacBalance: number;
  stGeorgeBalance: number;
  otherCashBalance: number;
  ndiaOutstanding: number;
  planManagerOutstanding: number;
  selfManagedOutstanding: number;
  hospitalsOutstanding: number;
  privateOutstanding: number;
  sahReceiptsMonthly: number;
  apOpenBalance: number;
  apWeeklyRun: number;
  atoArrearsBalance: number;
  atoMonthlyPaymentPlan: number;
  weeklyPayrollGross: number;
  weeklyEmployerSuper: number;
  weeklyPaygSc: number;
  monthlyPaygCq: number;
  minimumBalanceAlert: number;
};

export function buildForecast(input: BuildForecastInput): ForecastResult {
  const startingCash =
    input.westpacBalance + input.stGeorgeBalance + input.otherCashBalance;

  const today = new Date(input.asOfDate);
  today.setHours(0, 0, 0, 0);
  const firstMonday = startOfWeekMonday(today);
  const weekStarts: Date[] = [];
  for (let i = 0; i < 13; i++) {
    const d = new Date(firstMonday);
    d.setDate(firstMonday.getDate() + i * 7);
    weekStarts.push(d);
  }

  const arNdiaByWeek = allocateArToWeeks(input.ndiaOutstanding, AR_CADENCE_DAYS.ndia, weekStarts, today);
  const arPmByWeek = allocateArToWeeks(input.planManagerOutstanding, AR_CADENCE_DAYS.planManager, weekStarts, today);
  const arSmByWeek = allocateArToWeeks(input.selfManagedOutstanding, AR_CADENCE_DAYS.selfManaged, weekStarts, today);
  const arHospByWeek = allocateArToWeeks(input.hospitalsOutstanding, AR_CADENCE_DAYS.hospitals, weekStarts, today);
  const arPrivByWeek = allocateArToWeeks(input.privateOutstanding, AR_CADENCE_DAYS.private, weekStarts, today);

  // SaH monthly receipts land on the week containing a 1st-of-month.
  const sahByWeek = new Array(13).fill(0);
  for (let i = 0; i < 13; i++) {
    const wkStart = weekStarts[i];
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkStart.getDate() + 6);
    const checkMonths = [
      new Date(wkStart.getFullYear(), wkStart.getMonth(), 1),
      new Date(wkStart.getFullYear(), wkStart.getMonth() + 1, 1),
    ];
    for (const firstOfMonth of checkMonths) {
      if (firstOfMonth >= wkStart && firstOfMonth <= wkEnd) {
        sahByWeek[i] += input.sahReceiptsMonthly;
      }
    }
  }

  // Quarterly super lands on the week containing its due date (~one quarter of accrual).
  const superByWeek = new Array(13).fill(0);
  for (const dueIso of SUPER_QUARTERLY_DUE_DATES_ISO) {
    const due = new Date(dueIso + "T00:00:00");
    for (let i = 0; i < 13; i++) {
      const wkStart = weekStarts[i];
      const wkEnd = new Date(wkStart);
      wkEnd.setDate(wkStart.getDate() + 6);
      if (due >= wkStart && due <= wkEnd) {
        superByWeek[i] += input.weeklyEmployerSuper * 13;
      }
    }
  }

  // CQ monthly PAYG lands on the week containing the 21st of each month.
  const cqPaygByWeek = new Array(13).fill(0);
  for (let monthOffset = 0; monthOffset < 4; monthOffset++) {
    const ref = new Date(today.getFullYear(), today.getMonth() - 1 + monthOffset, 1);
    const dueDate = cqPaygDueDateForMonth(ref.getFullYear(), ref.getMonth());
    for (let i = 0; i < 13; i++) {
      const wkStart = weekStarts[i];
      const wkEnd = new Date(wkStart);
      wkEnd.setDate(wkStart.getDate() + 6);
      if (dueDate >= wkStart && dueDate <= wkEnd) {
        cqPaygByWeek[i] += input.monthlyPaygCq;
      }
    }
  }

  // AP — open balance settled over first 2 weeks, then weekly run.
  const apByWeek = new Array(13).fill(0);
  if (input.apOpenBalance > 0) {
    apByWeek[0] = input.apOpenBalance * 0.6;
    apByWeek[1] = input.apOpenBalance * 0.4;
  }
  for (let i = 0; i < 13; i++) apByWeek[i] += input.apWeeklyRun;

  // ATO payment plan — monthly on the 21st.
  const atoByWeek = new Array(13).fill(0);
  if (input.atoMonthlyPaymentPlan > 0) {
    for (let monthOffset = 0; monthOffset < 4; monthOffset++) {
      const ref = new Date(today.getFullYear(), today.getMonth() + monthOffset, 21);
      for (let i = 0; i < 13; i++) {
        const wkStart = weekStarts[i];
        const wkEnd = new Date(wkStart);
        wkEnd.setDate(wkStart.getDate() + 6);
        if (ref >= wkStart && ref <= wkEnd) {
          atoByWeek[i] += input.atoMonthlyPaymentPlan;
        }
      }
    }
  }

  const weeks: ForecastWeek[] = [];
  let running = startingCash;
  for (let i = 0; i < 13; i++) {
    const wkStart = weekStarts[i];
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkStart.getDate() + 6);

    const arNdia = arNdiaByWeek[i];
    const arPm = arPmByWeek[i];
    const arSm = arSmByWeek[i];
    const arHosp = arHospByWeek[i];
    const arPriv = arPrivByWeek[i];
    const sah = sahByWeek[i];
    const totalIn = arNdia + arPm + arSm + arHosp + arPriv + sah;

    const payroll = input.weeklyPayrollGross;
    const paygSc = input.weeklyPaygSc;
    const paygCq = cqPaygByWeek[i];
    const superQ = superByWeek[i];
    const ap = apByWeek[i];
    const ato = atoByWeek[i];
    const totalOut = payroll + paygSc + paygCq + superQ + ap + ato;

    const netFlow = totalIn - totalOut;
    const openingBalance = running;
    const closingBalance = openingBalance + netFlow;
    running = closingBalance;

    const fmt = (n: number) => n.toLocaleString("en-AU", { maximumFractionDigits: 0 });
    const notes: string[] = [];
    if (paygCq > 0) notes.push(`CQ PAYG due ($${fmt(paygCq)})`);
    if (superQ > 0) notes.push(`Quarterly super due ($${fmt(superQ)})`);
    if (sah > 0) notes.push(`SaH monthly receipt ($${fmt(sah)})`);
    if (ato > 0) notes.push(`ATO payment plan ($${fmt(ato)})`);

    weeks.push({
      weekNumber: i + 1,
      weekStarting: isoDate(wkStart),
      weekEnding: isoDate(wkEnd),
      openingBalance: round2(openingBalance),
      arNdia: round2(arNdia),
      arPlanManager: round2(arPm),
      arSelfManaged: round2(arSm),
      arHospitals: round2(arHosp),
      arPrivate: round2(arPriv),
      sahReceipts: round2(sah),
      totalInflows: round2(totalIn),
      payrollGross: round2(payroll),
      paygScWeekly: round2(paygSc),
      paygCqMonthly: round2(paygCq),
      employerSuperQuarterly: round2(superQ),
      apOutflow: round2(ap),
      atoPaymentPlan: round2(ato),
      totalOutflows: round2(totalOut),
      netFlow: round2(netFlow),
      closingBalance: round2(closingBalance),
      belowMinimum: closingBalance < input.minimumBalanceAlert,
      notes,
    });
  }

  let lowestWeek: ForecastWeek | null = null;
  let lowestBalance = Number.MAX_SAFE_INTEGER;
  let weeksBelowMinimum = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const w of weeks) {
    if (w.closingBalance < lowestBalance) {
      lowestBalance = w.closingBalance;
      lowestWeek = w;
    }
    if (w.belowMinimum) weeksBelowMinimum++;
    totalIn += w.totalInflows;
    totalOut += w.totalOutflows;
  }

  return {
    asOfDate: isoDate(input.asOfDate),
    startingCash: round2(startingCash),
    minimumBalanceAlert: input.minimumBalanceAlert,
    weeks,
    summary: {
      lowestWeek,
      lowestBalance: round2(lowestBalance),
      weeksBelowMinimum,
      totalInflows13w: round2(totalIn),
      totalOutflows13w: round2(totalOut),
      endingBalance: round2(weeks[weeks.length - 1]?.closingBalance ?? startingCash),
    },
  };
}

/** Decimal-row → buildForecast args. */
export function inputRowToBuildArgs(row: {
  asOfDate: Date;
  westpacBalance: Prisma.Decimal;
  stGeorgeBalance: Prisma.Decimal;
  otherCashBalance: Prisma.Decimal;
  ndiaOutstanding: Prisma.Decimal;
  planManagerOutstanding: Prisma.Decimal;
  selfManagedOutstanding: Prisma.Decimal;
  hospitalsOutstanding: Prisma.Decimal;
  privateOutstanding: Prisma.Decimal;
  sahReceiptsMonthly: Prisma.Decimal;
  apOpenBalance: Prisma.Decimal;
  apWeeklyRun: Prisma.Decimal;
  atoArrearsBalance: Prisma.Decimal;
  atoMonthlyPaymentPlan: Prisma.Decimal;
  weeklyPayrollGross: Prisma.Decimal;
  weeklyEmployerSuper: Prisma.Decimal;
  weeklyPaygSc: Prisma.Decimal;
  monthlyPaygCq: Prisma.Decimal;
  minimumBalanceAlert: Prisma.Decimal;
}): BuildForecastInput {
  return {
    asOfDate: row.asOfDate,
    westpacBalance: num(row.westpacBalance),
    stGeorgeBalance: num(row.stGeorgeBalance),
    otherCashBalance: num(row.otherCashBalance),
    ndiaOutstanding: num(row.ndiaOutstanding),
    planManagerOutstanding: num(row.planManagerOutstanding),
    selfManagedOutstanding: num(row.selfManagedOutstanding),
    hospitalsOutstanding: num(row.hospitalsOutstanding),
    privateOutstanding: num(row.privateOutstanding),
    sahReceiptsMonthly: num(row.sahReceiptsMonthly),
    apOpenBalance: num(row.apOpenBalance),
    apWeeklyRun: num(row.apWeeklyRun),
    atoArrearsBalance: num(row.atoArrearsBalance),
    atoMonthlyPaymentPlan: num(row.atoMonthlyPaymentPlan),
    weeklyPayrollGross: num(row.weeklyPayrollGross),
    weeklyEmployerSuper: num(row.weeklyEmployerSuper),
    weeklyPaygSc: num(row.weeklyPaygSc),
    monthlyPaygCq: num(row.monthlyPaygCq),
    minimumBalanceAlert: num(row.minimumBalanceAlert),
  };
}
