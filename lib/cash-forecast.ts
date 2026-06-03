// 13-week rolling cash forecast — pure compute, no I/O.  REWORKED 2026-06.
//
// What changed from v1: the inputs are now mostly AUTO-PULLED from Xero (bank
// balances, money owed split into the 7 JBC debtor types, bills owed), held
// per ENTITY (SC + CQ). We compute a forecast for SC, for CQ, and a COMBINED
// total. v1's typed-in single-entity form + invented "hospitals" bucket are gone.
//
// Honest model (unchanged where it was right):
//  - Spendable cash = the bank accounts Tony has ticked as cash (credit cards
//    and trust/property accounts excluded by default; he can override).
//  - Money owed (AR) is timed by debtor TYPE, not Xero due dates (those are
//    ~useless for NDIS/SaH). Each pool lands `cadenceDays` from today.
//  - Outflows: weekly payroll + super (quarterly bursts) + PAYG (SC weekly,
//    CQ monthly) + AP (open settled over 2 wks + weekly run) + ATO plan.
//  - Output per entity: 13 weeks of opening / inflows / outflows / net /
//    closing; anything closing below `minimumBalanceAlert` is flagged.

// ── The 7 live JBC debtor types (Tony-confirmed 2026-06) + "other" catch-all.
export const DEBTOR_TYPES = [
  "ndia",
  "sil",
  "sah",
  "brokerage",
  "private",
  "planManagement",
  "dva",
  "other",
] as const;
export type DebtorType = (typeof DEBTOR_TYPES)[number];

export const DEBTOR_LABELS: Record<DebtorType, string> = {
  ndia: "NDIA",
  sil: "SIL",
  sah: "SAH",
  brokerage: "Brokerage",
  private: "Private",
  planManagement: "Plan Management",
  dva: "DVA",
  other: "Other",
};

// Default days-until-cash by debtor type. Adjustable in the UI; persisted.
export const DEFAULT_CADENCE_DAYS: Record<DebtorType, number> = {
  ndia: 10,
  sil: 14,
  sah: 21,
  dva: 21,
  private: 21,
  planManagement: 30,
  brokerage: 30,
  other: 21,
};

export type TenantCode = "SC" | "CQ";

// One bank/cash account as pulled from Xero, plus Tony's include/exclude choice.
export type BankAccountState = {
  name: string;
  balance: number;
  kind: "cash" | "card" | "restricted";
  include: boolean;
};

// Forward-looking outflow assumptions — human-entered, persisted, per entity.
export type EntityAssumptions = {
  weeklyPayrollGross: number;
  weeklyEmployerSuper: number;
  weeklyPaygSc: number; // SC: weekly PAYG (Large Withholder). CQ: leave 0.
  monthlyPaygCq: number; // CQ: monthly PAYG due 21st. SC: leave 0.
  apWeeklyRun: number; // ongoing weekly bills beyond the open AP balance
  atoMonthlyPaymentPlan: number; // ATO arrears instalment (CQ ~$956)
  weeklyIncome: number; // ongoing money-IN run rate (P&L Total Income / 12wk avg)
};

// Everything we hold for ONE entity in a saved snapshot.
export type EntityState = {
  bankAccounts: BankAccountState[];
  ar: Record<DebtorType, number>; // money owed, by type (from Xero)
  apOpenBalance: number; // total bills owed now (from Xero)
  assumptions: EntityAssumptions;
};

// The whole saved snapshot.
export type CashForecastState = {
  asOfDate: string; // yyyy-mm-dd
  minimumBalanceAlert: number;
  cadenceDays: Record<DebtorType, number>;
  entities: Record<TenantCode, EntityState>;
  notes: string;
  pulledAt: string | null; // when Xero data was last pulled in
};

// Quarterly super safe-lodgement dates (28th of month after quarter end).
const SUPER_QUARTERLY_DUE_DATES_ISO = [
  "2026-04-28",
  "2026-07-28",
  "2026-10-28",
  "2027-01-28",
  "2027-04-28",
];

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
  arByType: Record<DebtorType, number>;
  ongoingIncome: number;
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

export type EntityForecast = {
  tenant: TenantCode | "COMBINED";
  startingCash: number;
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

export type ForecastResult = {
  asOfDate: string;
  minimumBalanceAlert: number;
  sc: EntityForecast;
  cq: EntityForecast;
  combined: EntityForecast;
};

function startOfWeekMonday(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function emptyArByType(): Record<DebtorType, number> {
  const o = {} as Record<DebtorType, number>;
  for (const t of DEBTOR_TYPES) o[t] = 0;
  return o;
}

// Allocate an AR pool to the single forecast week its cadence lands in. The
// whole `outstanding` lands `cadenceDays` from today. Beyond week 13 = dropped.
function allocateArToWeek(
  outstanding: number,
  cadenceDays: number,
  weekStarts: Date[],
  today: Date,
): number[] {
  const out = new Array(weekStarts.length).fill(0);
  if (outstanding <= 0) return out;
  const landing = new Date(today);
  landing.setDate(today.getDate() + cadenceDays);
  for (let i = 0; i < weekStarts.length; i++) {
    const wkStart = weekStarts[i];
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkStart.getDate() + 6);
    if (landing >= wkStart && landing <= wkEnd) {
      out[i] = outstanding;
      return out;
    }
  }
  return out;
}

function spendableCash(entity: EntityState): number {
  return entity.bankAccounts
    .filter((a) => a.include)
    .reduce((s, a) => s + a.balance, 0);
}

// Build a 13-week forecast for ONE entity.
function buildEntityForecast(
  tenant: TenantCode,
  entity: EntityState,
  cadenceDays: Record<DebtorType, number>,
  minimumBalanceAlert: number,
  today: Date,
  weekStarts: Date[],
): EntityForecast {
  const startingCash = spendableCash(entity);

  // AR landings per type.
  const arWeeks: Record<DebtorType, number[]> = {} as Record<DebtorType, number[]>;
  for (const t of DEBTOR_TYPES) {
    arWeeks[t] = allocateArToWeek(entity.ar[t] || 0, cadenceDays[t], weekStarts, today);
  }

  const a = entity.assumptions;

  // Quarterly super lands on its due-date week (~one quarter of weekly accrual).
  const superByWeek = new Array(13).fill(0);
  for (const dueIso of SUPER_QUARTERLY_DUE_DATES_ISO) {
    const due = new Date(dueIso + "T00:00:00");
    for (let i = 0; i < 13; i++) {
      const wkStart = weekStarts[i];
      const wkEnd = new Date(wkStart);
      wkEnd.setDate(wkStart.getDate() + 6);
      if (due >= wkStart && due <= wkEnd) superByWeek[i] += a.weeklyEmployerSuper * 13;
    }
  }

  // CQ monthly PAYG lands on the week containing the 21st of each month.
  const cqPaygByWeek = new Array(13).fill(0);
  if (a.monthlyPaygCq > 0) {
    for (let monthOffset = 0; monthOffset < 4; monthOffset++) {
      const ref = new Date(today.getFullYear(), today.getMonth() - 1 + monthOffset, 1);
      const dueDate = cqPaygDueDateForMonth(ref.getFullYear(), ref.getMonth());
      for (let i = 0; i < 13; i++) {
        const wkStart = weekStarts[i];
        const wkEnd = new Date(wkStart);
        wkEnd.setDate(wkStart.getDate() + 6);
        if (dueDate >= wkStart && dueDate <= wkEnd) cqPaygByWeek[i] += a.monthlyPaygCq;
      }
    }
  }

  // AP — open balance settled over first 2 weeks, then weekly run.
  const apByWeek = new Array(13).fill(0);
  if (entity.apOpenBalance > 0) {
    apByWeek[0] = entity.apOpenBalance * 0.6;
    apByWeek[1] = entity.apOpenBalance * 0.4;
  }
  for (let i = 0; i < 13; i++) apByWeek[i] += a.apWeeklyRun;

  // ATO payment plan — monthly on the 21st.
  const atoByWeek = new Array(13).fill(0);
  if (a.atoMonthlyPaymentPlan > 0) {
    for (let monthOffset = 0; monthOffset < 4; monthOffset++) {
      const ref = new Date(today.getFullYear(), today.getMonth() + monthOffset, 21);
      for (let i = 0; i < 13; i++) {
        const wkStart = weekStarts[i];
        const wkEnd = new Date(wkStart);
        wkEnd.setDate(wkStart.getDate() + 6);
        if (ref >= wkStart && ref <= wkEnd) atoByWeek[i] += a.atoMonthlyPaymentPlan;
      }
    }
  }

  // Ongoing weekly income (P&L run-rate). Starts landing after a 2-week
  // collection lag so it doesn't double-count today's AR backlog, which already
  // lands across the first weeks per cadence. Weeks 1-2 rely on current AR;
  // week 3 onward picks up the steady-state earned-and-collected run rate.
  const INCOME_COLLECTION_LAG_WEEKS = 2;
  const ongoingIncomeByWeek = new Array(13).fill(0);
  if (a.weeklyIncome > 0) {
    for (let i = INCOME_COLLECTION_LAG_WEEKS; i < 13; i++) {
      ongoingIncomeByWeek[i] = a.weeklyIncome;
    }
  }

  const weeks: ForecastWeek[] = [];
  let running = startingCash;
  for (let i = 0; i < 13; i++) {
    const wkStart = weekStarts[i];
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkStart.getDate() + 6);

    const arByType = emptyArByType();
    let totalIn = 0;
    for (const t of DEBTOR_TYPES) {
      arByType[t] = arWeeks[t][i];
      totalIn += arWeeks[t][i];
    }
    const ongoing = ongoingIncomeByWeek[i];
    totalIn += ongoing;

    const payroll = a.weeklyPayrollGross;
    const paygSc = a.weeklyPaygSc;
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
    if (ato > 0) notes.push(`ATO payment plan ($${fmt(ato)})`);
    if (ongoing > 0) notes.push(`Ongoing income ($${fmt(ongoing)})`);

    const arRounded = emptyArByType();
    for (const t of DEBTOR_TYPES) arRounded[t] = round2(arByType[t]);

    weeks.push({
      weekNumber: i + 1,
      weekStarting: isoDate(wkStart),
      weekEnding: isoDate(wkEnd),
      openingBalance: round2(openingBalance),
      arByType: arRounded,
      ongoingIncome: round2(ongoing),
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
      belowMinimum: closingBalance < minimumBalanceAlert,
      notes,
    });
  }

  return summarise(tenant, startingCash, weeks, minimumBalanceAlert);
}

function summarise(
  tenant: TenantCode | "COMBINED",
  startingCash: number,
  weeks: ForecastWeek[],
  minimumBalanceAlert: number,
): EntityForecast {
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
    tenant,
    startingCash: round2(startingCash),
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

// Sum two entity forecasts week-by-week into a combined view.
function combineForecasts(
  sc: EntityForecast,
  cq: EntityForecast,
  minimumBalanceAlert: number,
): EntityForecast {
  const startingCash = sc.startingCash + cq.startingCash;
  const weeks: ForecastWeek[] = [];
  for (let i = 0; i < 13; i++) {
    const a = sc.weeks[i];
    const b = cq.weeks[i];
    const arByType = emptyArByType();
    for (const t of DEBTOR_TYPES) arByType[t] = round2((a.arByType[t] || 0) + (b.arByType[t] || 0));
    const opening = round2(a.openingBalance + b.openingBalance);
    const closing = round2(a.closingBalance + b.closingBalance);
    weeks.push({
      weekNumber: i + 1,
      weekStarting: a.weekStarting,
      weekEnding: a.weekEnding,
      openingBalance: opening,
      arByType,
      ongoingIncome: round2(a.ongoingIncome + b.ongoingIncome),
      totalInflows: round2(a.totalInflows + b.totalInflows),
      payrollGross: round2(a.payrollGross + b.payrollGross),
      paygScWeekly: round2(a.paygScWeekly + b.paygScWeekly),
      paygCqMonthly: round2(a.paygCqMonthly + b.paygCqMonthly),
      employerSuperQuarterly: round2(a.employerSuperQuarterly + b.employerSuperQuarterly),
      apOutflow: round2(a.apOutflow + b.apOutflow),
      atoPaymentPlan: round2(a.atoPaymentPlan + b.atoPaymentPlan),
      totalOutflows: round2(a.totalOutflows + b.totalOutflows),
      netFlow: round2(a.netFlow + b.netFlow),
      closingBalance: closing,
      belowMinimum: closing < minimumBalanceAlert,
      notes: [],
    });
  }
  return summarise("COMBINED", startingCash, weeks, minimumBalanceAlert);
}

export function buildForecast(state: CashForecastState): ForecastResult {
  const today = new Date(state.asOfDate + "T00:00:00");
  today.setHours(0, 0, 0, 0);
  const firstMonday = startOfWeekMonday(today);
  const weekStarts: Date[] = [];
  for (let i = 0; i < 13; i++) {
    const d = new Date(firstMonday);
    d.setDate(firstMonday.getDate() + i * 7);
    weekStarts.push(d);
  }
  const min = state.minimumBalanceAlert;
  const sc = buildEntityForecast("SC", state.entities.SC, state.cadenceDays, min, today, weekStarts);
  const cq = buildEntityForecast("CQ", state.entities.CQ, state.cadenceDays, min, today, weekStarts);
  const combined = combineForecasts(sc, cq, min);
  return { asOfDate: state.asOfDate, minimumBalanceAlert: min, sc, cq, combined };
}

// A blank entity (used before the first Xero pull).
export function emptyEntityState(): EntityState {
  return {
    bankAccounts: [],
    ar: emptyArByType(),
    apOpenBalance: 0,
    assumptions: {
      weeklyPayrollGross: 0,
      weeklyEmployerSuper: 0,
      weeklyPaygSc: 0,
      monthlyPaygCq: 0,
      apWeeklyRun: 0,
      atoMonthlyPaymentPlan: 0,
      weeklyIncome: 0,
    },
  };
}

export function emptyState(asOfDate: string): CashForecastState {
  return {
    asOfDate,
    minimumBalanceAlert: 500000,
    cadenceDays: { ...DEFAULT_CADENCE_DAYS },
    entities: { SC: emptyEntityState(), CQ: emptyEntityState() },
    notes: "",
    pulledAt: null,
  };
}
