// In-chat tool — look up the labour-cost breakdown for ONE month of one entity,
// broken down by pay type (ordinary hours, overtime, casual loading, weekend/
// shift loadings, travel, leave, super, allowances).
//
// Same pattern as lookup_month_detail (P&L): Mark's prompt carries the payroll
// TOTALS per month; this tool fetches the per-pay-type detail on demand when the
// user asks "how much overtime", "what's the travel-allowance spend", "break
// down the wages", etc.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../prisma";

export const LOOKUP_PAYROLL_DETAIL_TOOL: Anthropic.Messages.Tool = {
  name: "lookup_payroll_detail",
  description:
    "Look up the labour-cost breakdown for ONE month of one entity, split by PAY " +
    "TYPE — ordinary hours, overtime, casual loading, weekend/shift loadings, " +
    "travel allowances, leave taken, employer super, etc. Call this whenever the " +
    "user asks to break down wages/payroll or asks about a specific pay component, " +
    "e.g. 'how much overtime did SC pay in May', 'what's our travel-allowance " +
    "spend', 'break down CQ's wages last month', 'how much super'. The monthly " +
    "payroll TOTALS (gross, super, allowances) are already in your context; only " +
    "call this for the line-by-line pay-type detail. Quote amounts EXACTLY. " +
    "IMPORTANT: this is split by pay TYPE, NOT by funding stream — you CANNOT get " +
    "'NDIS staff wages' vs 'Home Care wages' from this; the pay codes don't carry " +
    "the client programme. If asked for wages by funding stream, say plainly that " +
    "payroll isn't tagged that way and it would need an AlayaCare visit join.",
  input_schema: {
    type: "object",
    properties: {
      entity: { type: "string", enum: ["SC", "CQ"], description: "SC (Sunshine Coast) or CQ (Central Queensland)." },
      month: { type: "string", description: 'Month as "YYYY-MM", e.g. "2026-05".' },
    },
    required: ["entity", "month"],
  },
};

interface LookupInput {
  entity?: unknown;
  month?: unknown;
}

interface PayLine {
  payType: string;
  category: string;
  amount: number;
}

export interface PayrollLookupResult {
  ok: boolean;
  entity: string;
  month: string;
  message: string;
  totals?: {
    totalGross: number | null;
    totalSuper: number | null;
    totalAllowances: number | null;
    totalLeaveTaken: number | null;
  };
  // Grouped for easy reading: pay (Income), allowances, leave, super.
  breakdown?: {
    pay: PayLine[];
    allowances: PayLine[];
    leave: PayLine[];
    super: PayLine[];
    other: PayLine[];
  };
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export async function executeLookupPayrollDetailTool(args: LookupInput): Promise<PayrollLookupResult> {
  const entity = typeof args.entity === "string" ? args.entity.toUpperCase() : "";
  const month = typeof args.month === "string" ? args.month.trim() : "";

  if (entity !== "SC" && entity !== "CQ") {
    return { ok: false, entity, month, message: 'entity must be "SC" or "CQ".' };
  }
  if (!MONTH_RE.test(month)) {
    return { ok: false, entity, month, message: 'month must be "YYYY-MM" e.g. "2026-05".' };
  }

  const row = await prisma.payrollMonth.findUnique({
    where: { entityCode_month: { entityCode: entity, month } },
  });

  if (!row) {
    return {
      ok: false,
      entity,
      month,
      message: `No stored payroll for ${entity} ${month}. That pay run may not have been uploaded yet on the Payroll detail page.`,
    };
  }

  const totals = {
    totalGross: row.totalGross,
    totalSuper: row.totalSuper,
    totalAllowances: row.totalAllowances,
    totalLeaveTaken: row.totalLeaveTaken,
  };

  const lines = Array.isArray(row.lineItems) ? (row.lineItems as unknown as PayLine[]) : [];
  const pick = (pred: (l: PayLine) => boolean) =>
    lines.filter(pred).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return {
    ok: true,
    entity,
    month,
    message: `Payroll detail for ${entity} ${month}: ${lines.length} pay-type lines.`,
    totals,
    breakdown: {
      pay: pick((l) => l.category === "Income"),
      allowances: pick((l) => l.category === "Allowance"),
      leave: pick((l) => l.category === "Entitlement Payment"),
      super: pick((l) => l.category === "Employer Super" || l.category === "Employee Super"),
      other: pick(
        (l) => !["Income", "Allowance", "Entitlement Payment", "Employer Super", "Employee Super"].includes(l.category),
      ),
    },
  };
}
