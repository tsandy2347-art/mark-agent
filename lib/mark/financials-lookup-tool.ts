// In-chat tool — look up the per-account P&L breakdown for one OR MANY months
// across one OR both entities in a single call.
//
// WHY: Mark's prompt carries the TOTALS for every stored month (income, costs,
// net profit) so he answers profit/trend questions instantly. The detailed line
// items are heavy (~45/month × 24 months × 2 entities ≈ 2,500 rows) so they
// stay out of the prompt and Mark calls THIS tool on demand.
//
// PERFORMANCE: voice questions like "compare Q1 vs Q2 expenses" need 6+ months
// per entity. The old one-month-at-a-time API meant 12+ sequential think-tool-
// think cycles and Vapi would drop the call. This version takes an array of
// months AND an "entity = SC | CQ | both", reads them all in one DB hit, and
// optionally pre-aggregates two periods so Mark doesn't have to add them up.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../prisma";
import { streamOf } from "./revenue";

// For income lines we collapse the raw Xero account name to Tony's canonical
// stream label (NDIA / SAH / Private / Brokerage / SIL / Plan Mgmt / DVA /
// Other). Without this, Mark sees "HCP Income" and "SAH Income" as separate
// streams and reads them both out — but HCP is the legacy name for SAH (same
// program, just renamed under the reform), so they MUST be presented as one.
function foldIncomeAccount(section: PLLine["section"], account: string): string {
  if (section !== "income") return account;
  const s = streamOf(account);
  // Map to a user-facing stream label. "Other" stays as "Other Income" so it
  // never silently disappears.
  return s === "Other" ? "Other Income" : `${s} Income`;
}

function foldLineItems(items: PLLine[]): PLLine[] {
  // Group income by canonical stream; pass through every other section.
  const byKey = new Map<string, PLLine>();
  const out: PLLine[] = [];
  for (const li of items) {
    if (li.section !== "income") {
      out.push(li);
      continue;
    }
    const folded = foldIncomeAccount(li.section, li.account);
    const k = `income|${folded}`;
    const cur = byKey.get(k);
    if (cur) cur.amount += li.amount;
    else {
      const merged: PLLine = { section: "income", account: folded, amount: li.amount };
      byKey.set(k, merged);
      out.push(merged);
    }
  }
  return out;
}

export const LOOKUP_MONTH_DETAIL_TOOL: Anthropic.Messages.Tool = {
  name: "lookup_month_detail",
  description:
    "Look up the per-account Profit & Loss breakdown for one or many months " +
    "across one or both entities in a SINGLE call. Use the months array for " +
    "any multi-month question — never call this tool repeatedly for a span. " +
    "For period comparisons (this quarter vs last quarter, H1 vs H2, etc.), " +
    "set compare={periodA:[YYYY-MM,...], periodB:[YYYY-MM,...]} and the tool " +
    "returns the aggregated totals AND top-changing accounts ready to read out. " +
    "Quote returned amounts EXACTLY; never estimate. If a month has no stored " +
    "detail the tool says so per-month — tell the user that month's line " +
    "detail wasn't uploaded.",
  input_schema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        enum: ["SC", "CQ", "both"],
        description:
          'Which entity: "SC" (Sunshine Coast), "CQ" (Central Queensland), or "both" to get them combined and per-entity in one call.',
      },
      months: {
        type: "array",
        items: { type: "string" },
        description:
          'Array of months to pull, each as "YYYY-MM". For a single month pass an array of one. For a quarter pass three. For a range pass them all.',
      },
      compare: {
        type: "object",
        description:
          "OPTIONAL. If set, the tool aggregates two periods and returns the totals plus the top 10 line items that changed the most between them. Use for any 'X vs Y' question.",
        properties: {
          periodA: { type: "array", items: { type: "string" }, description: 'Months in period A, e.g. ["2026-01","2026-02","2026-03"].' },
          periodB: { type: "array", items: { type: "string" }, description: 'Months in period B, e.g. ["2025-10","2025-11","2025-12"].' },
          labelA: { type: "string", description: 'Human label for period A, e.g. "Q3 FY26".' },
          labelB: { type: "string", description: 'Human label for period B, e.g. "Q2 FY26".' },
        },
        required: ["periodA", "periodB"],
      },
    },
    required: ["entity", "months"],
  },
};

interface LookupInput {
  entity?: unknown;
  months?: unknown;
  compare?: unknown;
}

interface PLLine {
  section: "income" | "costOfSales" | "otherIncome" | "operating";
  account: string;
  amount: number;
}

interface MonthTotals {
  totalIncome: number | null;
  totalCostOfSales: number | null;
  grossProfit: number | null;
  totalOtherIncome: number | null;
  totalOperatingExpenses: number | null;
  netProfit: number | null;
}

interface MonthSlice {
  entity: "SC" | "CQ";
  month: string;
  totals: MonthTotals;
  lineItems: PLLine[]; // empty if not stored
  hasDetail: boolean;
  note?: string;
}

export interface LookupResult {
  ok: boolean;
  message: string;
  months?: MonthSlice[];
  compare?: {
    labelA: string;
    labelB: string;
    periodA: { totals: MonthTotals; byAccount: { account: string; amount: number; section: PLLine["section"] }[] };
    periodB: { totals: MonthTotals; byAccount: { account: string; amount: number; section: PLLine["section"] }[] };
    topChanges: { account: string; section: PLLine["section"]; a: number; b: number; delta: number; pct: number | null }[];
    totalsDelta: Partial<MonthTotals>;
  };
}

const MONTH_RE = /^\d{4}-\d{2}$/;

function emptyTotals(): MonthTotals {
  return {
    totalIncome: 0,
    totalCostOfSales: 0,
    grossProfit: 0,
    totalOtherIncome: 0,
    totalOperatingExpenses: 0,
    netProfit: 0,
  };
}

function addTotals(acc: MonthTotals, t: MonthTotals): MonthTotals {
  const add = (a: number | null, b: number | null) => (a ?? 0) + (b ?? 0);
  return {
    totalIncome: add(acc.totalIncome, t.totalIncome),
    totalCostOfSales: add(acc.totalCostOfSales, t.totalCostOfSales),
    grossProfit: add(acc.grossProfit, t.grossProfit),
    totalOtherIncome: add(acc.totalOtherIncome, t.totalOtherIncome),
    totalOperatingExpenses: add(acc.totalOperatingExpenses, t.totalOperatingExpenses),
    netProfit: add(acc.netProfit, t.netProfit),
  };
}

export async function executeLookupMonthDetailTool(args: LookupInput): Promise<LookupResult> {
  const entityArg = typeof args.entity === "string" ? args.entity.toUpperCase() : "";
  const entities: ("SC" | "CQ")[] =
    entityArg === "BOTH" ? ["SC", "CQ"] : entityArg === "SC" || entityArg === "CQ" ? [entityArg] : [];
  if (!entities.length) {
    return { ok: false, message: 'entity must be "SC", "CQ", or "both".' };
  }

  const monthsArg = Array.isArray(args.months) ? args.months : [];
  const months = monthsArg.filter((m): m is string => typeof m === "string" && MONTH_RE.test(m));
  if (!months.length) {
    return { ok: false, message: 'months must be a non-empty array of "YYYY-MM" strings.' };
  }

  // Single DB read for everything.
  const rows = await prisma.monthlyFinancials.findMany({
    where: { entityCode: { in: entities }, month: { in: months } },
  });

  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byKey.set(`${r.entityCode}|${r.month}`, r);

  const slices: MonthSlice[] = [];
  for (const e of entities) {
    for (const m of months) {
      const r = byKey.get(`${e}|${m}`);
      if (!r) {
        slices.push({
          entity: e,
          month: m,
          totals: emptyTotals(),
          lineItems: [],
          hasDetail: false,
          note: `No stored P&L for ${e} ${m}.`,
        });
        continue;
      }
      const raw = Array.isArray(r.lineItems) ? (r.lineItems as unknown as PLLine[]) : [];
      const folded = foldLineItems(raw);
      const sorted = [...folded].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      slices.push({
        entity: e,
        month: m,
        totals: {
          totalIncome: r.totalIncome,
          totalCostOfSales: r.totalCostOfSales,
          grossProfit: r.grossProfit,
          totalOtherIncome: r.totalOtherIncome,
          totalOperatingExpenses: r.totalOperatingExpenses,
          netProfit: r.netProfit,
        },
        lineItems: sorted,
        hasDetail: raw.length > 0,
        note: raw.length === 0 ? "Totals only — line detail not uploaded for this month." : undefined,
      });
    }
  }

  // Period comparison (optional).
  let compare: LookupResult["compare"] | undefined;
  const cmpRaw = args.compare as { periodA?: unknown; periodB?: unknown; labelA?: unknown; labelB?: unknown } | undefined;
  if (cmpRaw && Array.isArray(cmpRaw.periodA) && Array.isArray(cmpRaw.periodB)) {
    const periodA = (cmpRaw.periodA as unknown[]).filter((x): x is string => typeof x === "string" && MONTH_RE.test(x));
    const periodB = (cmpRaw.periodB as unknown[]).filter((x): x is string => typeof x === "string" && MONTH_RE.test(x));
    const labelA = typeof cmpRaw.labelA === "string" ? cmpRaw.labelA : `Period A (${periodA.join(",")})`;
    const labelB = typeof cmpRaw.labelB === "string" ? cmpRaw.labelB : `Period B (${periodB.join(",")})`;

    // Fetch any compare months not already in `rows` (covers cases where caller
    // didn't include them in `months`).
    const extra = [...periodA, ...periodB].filter((m) => !months.includes(m));
    let allRows = rows;
    if (extra.length) {
      const more = await prisma.monthlyFinancials.findMany({
        where: { entityCode: { in: entities }, month: { in: extra } },
      });
      allRows = [...rows, ...more];
    }

    const aggregate = (periodMonths: string[]) => {
      let totals = emptyTotals();
      const byAccount = new Map<string, { account: string; section: PLLine["section"]; amount: number }>();
      for (const e of entities) {
        for (const m of periodMonths) {
          const r = allRows.find((x) => x.entityCode === e && x.month === m);
          if (!r) continue;
          totals = addTotals(totals, {
            totalIncome: r.totalIncome,
            totalCostOfSales: r.totalCostOfSales,
            grossProfit: r.grossProfit,
            totalOtherIncome: r.totalOtherIncome,
            totalOperatingExpenses: r.totalOperatingExpenses,
            netProfit: r.netProfit,
          });
          const raw = Array.isArray(r.lineItems) ? (r.lineItems as unknown as PLLine[]) : [];
          const folded = foldLineItems(raw);
          for (const l of folded) {
            const k = `${l.section}|${l.account}`;
            const cur = byAccount.get(k);
            if (cur) cur.amount += l.amount;
            else byAccount.set(k, { account: l.account, section: l.section, amount: l.amount });
          }
        }
      }
      return {
        totals,
        byAccount: [...byAccount.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
      };
    };

    const aggA = aggregate(periodA);
    const aggB = aggregate(periodB);

    // Top-changing accounts by absolute delta.
    const keys = new Set<string>();
    for (const x of aggA.byAccount) keys.add(`${x.section}|${x.account}`);
    for (const x of aggB.byAccount) keys.add(`${x.section}|${x.account}`);
    const changes = [...keys].map((k) => {
      const a = aggA.byAccount.find((x) => `${x.section}|${x.account}` === k);
      const b = aggB.byAccount.find((x) => `${x.section}|${x.account}` === k);
      const aAmt = a?.amount ?? 0;
      const bAmt = b?.amount ?? 0;
      const section = (a?.section ?? b?.section) as PLLine["section"];
      const account = a?.account ?? b?.account ?? "(unknown)";
      const delta = aAmt - bAmt;
      const pct = bAmt !== 0 ? (delta / Math.abs(bAmt)) * 100 : null;
      return { account, section, a: aAmt, b: bAmt, delta, pct };
    });
    const topChanges = changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 10);

    const totalsDelta: Partial<MonthTotals> = {
      totalIncome: (aggA.totals.totalIncome ?? 0) - (aggB.totals.totalIncome ?? 0),
      totalCostOfSales: (aggA.totals.totalCostOfSales ?? 0) - (aggB.totals.totalCostOfSales ?? 0),
      grossProfit: (aggA.totals.grossProfit ?? 0) - (aggB.totals.grossProfit ?? 0),
      totalOtherIncome: (aggA.totals.totalOtherIncome ?? 0) - (aggB.totals.totalOtherIncome ?? 0),
      totalOperatingExpenses: (aggA.totals.totalOperatingExpenses ?? 0) - (aggB.totals.totalOperatingExpenses ?? 0),
      netProfit: (aggA.totals.netProfit ?? 0) - (aggB.totals.netProfit ?? 0),
    };

    compare = {
      labelA,
      labelB,
      periodA: aggA,
      periodB: aggB,
      topChanges,
      totalsDelta,
    };
  }

  return {
    ok: true,
    message: `Returned ${slices.length} entity-month slice(s)${compare ? " plus period comparison." : "."}`,
    months: slices,
    ...(compare ? { compare } : {}),
  };
}
