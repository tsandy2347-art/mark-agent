// In-chat tool — look up the full per-account breakdown for ONE month of one
// entity's Profit & Loss, on demand.
//
// WHY: Mark's prompt carries the TOTALS for every stored month (income, costs,
// net profit) so he answers profit/trend questions instantly. But the detailed
// line items (every expense account) are heavy — ~45 lines/month x 24 months x 2
// entities ≈ 2,500 rows. Dumping all of that into every prompt bloats it and
// (worse) garbles the numbers when the backend truncates. So instead Mark keeps
// only totals in view and calls THIS tool when the user asks for a breakdown of
// a specific month ("what were SC's expenses in October", "biggest cost in
// March", "how much on wages"). One quick DB read, no Xero, full accuracy.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../prisma";

export const LOOKUP_MONTH_DETAIL_TOOL: Anthropic.Messages.Tool = {
  name: "lookup_month_detail",
  description:
    "Look up the full per-account Profit & Loss breakdown for ONE month of one " +
    "entity (the individual income and expense lines — wages, franchise fees, " +
    "rent, insurance, etc.). Call this whenever the user asks to break a month " +
    "down or asks about a specific cost/income account, e.g. 'what were SC's " +
    "biggest expenses in October 2025', 'how much did CQ spend on wages in " +
    "March', 'what made up the income last month'. The month TOTALS are already " +
    "in your context (the financials block) — only call this when you need the " +
    "line-by-line detail. Quote the returned amounts EXACTLY; never estimate. " +
    "If the month has no stored detail, the tool says so — tell the user you " +
    "have the totals but the line detail for that month hasn't been uploaded.",
  input_schema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        enum: ["SC", "CQ"],
        description: "Which entity: SC (Sunshine Coast) or CQ (Central Queensland).",
      },
      month: {
        type: "string",
        description: 'The month as "YYYY-MM", e.g. "2025-10" for October 2025.',
      },
    },
    required: ["entity", "month"],
  },
};

interface LookupInput {
  entity?: unknown;
  month?: unknown;
}

interface PLLine {
  section: "income" | "costOfSales" | "otherIncome" | "operating";
  account: string;
  amount: number;
}

export interface LookupResult {
  ok: boolean;
  entity: string;
  month: string;
  message: string;
  totals?: {
    totalIncome: number | null;
    totalCostOfSales: number | null;
    grossProfit: number | null;
    totalOtherIncome: number | null;
    totalOperatingExpenses: number | null;
    netProfit: number | null;
  };
  // Line items grouped by section, each sorted biggest-first so Mark can answer
  // "biggest expense" without re-sorting.
  lineItems?: {
    income: PLLine[];
    costOfSales: PLLine[];
    otherIncome: PLLine[];
    operating: PLLine[];
  };
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export async function executeLookupMonthDetailTool(args: LookupInput): Promise<LookupResult> {
  const entity = typeof args.entity === "string" ? args.entity.toUpperCase() : "";
  const month = typeof args.month === "string" ? args.month.trim() : "";

  if (entity !== "SC" && entity !== "CQ") {
    return { ok: false, entity, month, message: 'entity must be "SC" or "CQ".' };
  }
  if (!MONTH_RE.test(month)) {
    return { ok: false, entity, month, message: 'month must be "YYYY-MM" e.g. "2025-10".' };
  }

  const row = await prisma.monthlyFinancials.findUnique({
    where: { entityCode_month: { entityCode: entity, month } },
  });

  if (!row) {
    return {
      ok: false,
      entity,
      month,
      message: `No stored P&L for ${entity} ${month}. It may be outside the uploaded range, or that month hasn't been uploaded yet on the Profit history page.`,
    };
  }

  const totals = {
    totalIncome: row.totalIncome,
    totalCostOfSales: row.totalCostOfSales,
    grossProfit: row.grossProfit,
    totalOtherIncome: row.totalOtherIncome,
    totalOperatingExpenses: row.totalOperatingExpenses,
    netProfit: row.netProfit,
  };

  const raw = Array.isArray(row.lineItems) ? (row.lineItems as unknown as PLLine[]) : [];
  if (!raw.length) {
    return {
      ok: true,
      entity,
      month,
      message: `Totals only for ${entity} ${month} — the line-by-line detail wasn't captured for this month (older uploads stored totals only). Re-upload that month's Xero P&L on the Profit history page to get the breakdown.`,
      totals,
    };
  }

  const bySection = (s: PLLine["section"]) =>
    raw.filter((l) => l.section === s).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return {
    ok: true,
    entity,
    month,
    message: `P&L detail for ${entity} ${month}: ${raw.length} account lines.`,
    totals,
    lineItems: {
      income: bySection("income"),
      costOfSales: bySection("costOfSales"),
      otherIncome: bySection("otherIncome"),
      operating: bySection("operating"),
    },
  };
}
