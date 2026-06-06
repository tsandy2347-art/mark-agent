// Revenue data layer — reads the stored MonthlyFinancials rows.
//
// Income breakdown is on `lineItems` (section='income') as `{account, amount}`
// per stream. We map the chart-of-accounts names → Tony's seven canonical
// stream labels and roll up across SC + CQ for the dashboard.

import { prisma } from "../prisma";

export const STREAMS = [
  "NDIA",
  "SAH",         // includes legacy HCP (Home Care Package) — same program, renamed
  "Private",
  "Brokerage",
  "SIL",
  "Plan Mgmt",
  "DVA",
] as const;
export type Stream = (typeof STREAMS)[number];

// Map Xero account names to Tony's canonical streams. Anything not matched
// goes to "Other" (still surfaced — never silently dropped).
//
// EXPORTED so the financials-lookup tool (and any other consumer) folds the
// same way the /reports/revenue page does. Without this, Mark sees raw Xero
// rows and reads HCP + SAH as TWO streams when they're the same program.
export function streamOf(accountName: string): Stream | "Other" {
  const n = accountName.toLowerCase();
  // HCP = legacy Home Care Package; folded into SAH (Support at Home) — same
  // program, just renamed under the reform. Tony's rule.
  if (n.includes("hcp") || n.includes("home care package")) return "SAH";
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
  /** Last fully-settled month per Tony's rule (see lastSettledMonth). */
  asOfMonth: string;
  asOfLabel: string;
  /** Per-entity views of the last 13 months. Combined is intentionally
   *  excluded — Tony's call: "combined is no good for me". */
  entities: {
    entity: "SC" | "CQ";
    monthly: MonthByStream[];      // 13 months, oldest → newest
    asOf: MonthByStream;
    prevMonth?: MonthByStream;
    yoyMonth?: MonthByStream;
  }[];
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

/** Last fully-settled month per Tony's rule:
 *  "May won't show until 20 June" — i.e. a calendar month X is only counted
 *  as settled once we're past the 20th of the FOLLOWING month. So:
 *  - On 5 June  → April is the latest settled (May still in arrears).
 *  - On 20 June → May becomes the latest.
 *  - On 5 July  → May is still the latest (June not settled until 20 July).
 *  Always returns previous-or-earlier — never the current month. */
export function lastSettledMonth(today: Date = new Date()): string {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1; // 1-12
  const day = today.getUTCDate();
  // If we're at or past the 20th, the previous month is settled.
  // Otherwise the month before that is the latest settled.
  const back = day >= 20 ? 1 : 2;
  let nm = m - back;
  let ny = y;
  while (nm <= 0) { nm += 12; ny -= 1; }
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

  // Per-entity x per-month bucket
  const byEnt = new Map<string, Map<string, Array<{ totalIncome: number | null; lineItems: unknown }>>>();
  for (const ent of ["SC", "CQ"]) byEnt.set(ent, new Map());
  for (const r of rows) {
    const em = byEnt.get(r.entityCode);
    if (!em) continue;
    if (!em.has(r.month)) em.set(r.month, []);
    em.get(r.month)!.push({ totalIncome: r.totalIncome, lineItems: r.lineItems });
  }

  const entities: RevenueSummary["entities"] = (["SC", "CQ"] as const).map((ent) => {
    const em = byEnt.get(ent) ?? new Map();
    const monthly = months.map((m) => rollMonth(em.get(m) ?? [], m));
    const asOfRow = monthly.find((m) => m.month === asOf)!;
    const prev = monthly.find((m) => m.month === decMonth(asOf, 1));
    const yoy = monthly.find((m) => m.month === decMonth(asOf, 12));
    return { entity: ent, monthly, asOf: asOfRow, prevMonth: prev, yoyMonth: yoy };
  });

  return { asOfMonth: asOf, asOfLabel: monthLabel(asOf), entities };
}

export function pctDelta(now: number, prev: number | undefined): { abs: number; pct: number | null } {
  if (prev === undefined || prev === 0) return { abs: now - (prev ?? 0), pct: null };
  return { abs: now - prev, pct: ((now - prev) / Math.abs(prev)) * 100 };
}
