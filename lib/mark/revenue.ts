// Revenue data layer — reads the stored MonthlyFinancials rows.
//
// Income breakdown is on `lineItems` (section='income') as `{account, amount}`
// per stream. We map the chart-of-accounts names → Tony's seven canonical
// stream labels and roll up across SC + CQ for the dashboard.

import { prisma } from "../prisma";

export const STREAMS = [
  "NDIA",
  "SAH",
  "Private",
  "Brokerage",
  "SIL",
  "Plan Mgmt",
  "DVA",
] as const;
export type Stream = (typeof STREAMS)[number];

// Map Xero account names to Tony's seven streams. Anything not matched goes
// to "Other" (still surfaced — never silently dropped).
function streamOf(accountName: string): Stream | "Other" {
  const n = accountName.toLowerCase();
  if (n.includes("ndis") || n.includes("ndia")) return "NDIA";
  if (n.includes("sah") || n.includes("support at home")) return "SAH";
  if (n.includes("dva")) return "DVA";
  if (n.includes("plan management")) return "Plan Mgmt";
  if (n.includes("brokerage")) return "Brokerage";
  if (n.includes("private")) return "Private";
  if (n.includes("sil")) return "SIL";
  return "Other";
}

interface LineItem { section?: string; account?: string; amount?: number }

export interface MonthByStream {
  month: string; // YYYY-MM
  total: number;
  byStream: Record<Stream | "Other", number>;
}

export interface RevenueSummary {
  /** Last fully-settled month — "current month, only if past day 20; otherwise
   *  previous month". Honours the arrears rule. */
  asOfMonth: string;
  asOfLabel: string;
  /** Total revenue split — last 13 months. Ordered oldest → newest. */
  monthly: MonthByStream[];
  /** Per-entity (SC, CQ) version of the same 13-month series for the entity
   *  table. Only the most recent month gets shown there. */
  entityMostRecent: { entity: "SC" | "CQ"; month: string; total: number; byStream: Record<Stream | "Other", number> }[];
  /** Quick deltas for the three headline numbers. */
  prevMonth?: MonthByStream;
  yoyMonth?: MonthByStream;
  asOf: MonthByStream;
}

function emptyByStream(): Record<Stream | "Other", number> {
  return { NDIA: 0, SAH: 0, Private: 0, Brokerage: 0, SIL: 0, "Plan Mgmt": 0, DVA: 0, Other: 0 };
}

function decMonth(ym: string, by = 1): string {
  const [y, m] = ym.split("-").map(Number);
  let nm = m - by;
  let ny = y;
  while (nm <= 0) { nm += 12; ny -= 1; }
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-AU", { month: "long", year: "numeric" });
}

/** "Last fully-settled" month — current if today >= the 20th, else previous. */
export function lastSettledMonth(today: Date = new Date()): string {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1; // 1-12
  const day = today.getUTCDate();
  if (day >= 20) return `${y}-${String(m).padStart(2, "0")}`;
  // previous month
  const ny = m === 1 ? y - 1 : y;
  const nm = m === 1 ? 12 : m - 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function rollMonth(rows: Array<{ totalIncome: number | null; lineItems: unknown }>, month: string): MonthByStream {
  const out: MonthByStream = { month, total: 0, byStream: emptyByStream() };
  for (const r of rows) {
    out.total += r.totalIncome ?? 0;
    const items = Array.isArray(r.lineItems) ? (r.lineItems as LineItem[]) : [];
    for (const i of items) {
      if (i.section !== "income") continue;
      const stream = streamOf(i.account ?? "");
      out.byStream[stream] += i.amount ?? 0;
    }
  }
  return out;
}

export async function loadRevenueSummary(): Promise<RevenueSummary> {
  const asOf = lastSettledMonth();
  const months: string[] = [];
  for (let i = 12; i >= 0; i--) months.push(decMonth(asOf, i));

  const rows = await prisma.monthlyFinancials.findMany({
    where: { month: { in: months } },
    select: { entityCode: true, month: true, totalIncome: true, lineItems: true },
  });

  // Combined per month
  const byMonth = new Map<string, Array<{ totalIncome: number | null; lineItems: unknown }>>();
  for (const r of rows) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, []);
    byMonth.get(r.month)!.push({ totalIncome: r.totalIncome, lineItems: r.lineItems });
  }

  const monthly = months.map((m) => rollMonth(byMonth.get(m) ?? [], m));

  const asOfRow = monthly.find((m) => m.month === asOf)!;
  const prevRow = monthly.find((m) => m.month === decMonth(asOf, 1));
  const yoyRow  = monthly.find((m) => m.month === decMonth(asOf, 12));

  // Per-entity, just for the asOf month
  const entityMostRecent: RevenueSummary["entityMostRecent"] = [];
  for (const ent of ["SC", "CQ"] as const) {
    const r = rows.find((x) => x.entityCode === ent && x.month === asOf);
    if (!r) {
      entityMostRecent.push({ entity: ent, month: asOf, total: 0, byStream: emptyByStream() });
      continue;
    }
    const m = rollMonth([{ totalIncome: r.totalIncome, lineItems: r.lineItems }], asOf);
    entityMostRecent.push({ entity: ent, month: asOf, total: m.total, byStream: m.byStream });
  }

  return {
    asOfMonth: asOf,
    asOfLabel: monthLabel(asOf),
    monthly,
    entityMostRecent,
    asOf: asOfRow,
    prevMonth: prevRow,
    yoyMonth: yoyRow,
  };
}

export function pctDelta(now: number, prev: number | undefined): { abs: number; pct: number | null } {
  if (prev === undefined || prev === 0) return { abs: now - (prev ?? 0), pct: null };
  return { abs: now - prev, pct: ((now - prev) / Math.abs(prev)) * 100 };
}
