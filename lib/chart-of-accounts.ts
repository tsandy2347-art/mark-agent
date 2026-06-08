// JBC chart of accounts — typed accessors over the auto-generated CSV import.
//
// Tony's "Mark needs to remember the account codes" lives here. Honcho is the
// wrong layer for this: it's deriver-built from chat transcripts, not a
// reliable key/value store. The CSVs under data/chart-of-accounts/ are the
// authoritative source; scripts/build-chart.ts converts them to the .generated
// file this module re-exports. To refresh: replace the CSV, run `npm run
// build:chart`, commit both.

import {
  CQ_ACCOUNTS,
  SC_ACCOUNTS,
  type AccountRow,
} from "./chart-of-accounts.generated";

export type Entity = "SC" | "CQ";

export function getChart(entity: Entity): AccountRow[] {
  return entity === "SC" ? SC_ACCOUNTS : CQ_ACCOUNTS;
}

export function findAccount(entity: Entity, code: string): AccountRow | null {
  const c = code.trim();
  const chart = getChart(entity);
  return chart.find((a) => a.code === c) ?? null;
}

function shortTax(tax: string): string {
  switch (tax) {
    case "GST on Income":
      return "GST inc";
    case "GST Free Income":
      return "GST-free inc";
    case "GST on Expenses":
      return "GST exp";
    case "GST Free Expenses":
      return "GST-free exp";
    case "BAS Excluded":
      return "BAS excl";
    default:
      return tax;
  }
}

// Order types so the most journal-relevant ones come first. Anything not in
// this list falls to the end in CSV order.
const TYPE_ORDER: string[] = [
  "Revenue",
  "Other Income",
  "Direct Costs",
  "Expense",
  "Depreciation",
  "Current Asset",
  "Accounts Receivable",
  "Fixed Asset",
  "Non-Current Asset",
  "Current Liability",
  "Accounts Payable",
  "Unpaid Expense Claims",
  "Non-current Liability",
  "Liability",
  "GST",
  "Tracking",
  "Rounding",
  "Equity",
  "Retained Earnings",
  "Historical",
  "Bank",
];

/**
 * Compact text block for injection into a system prompt. Grouped by *Type, one
 * account per line as `code  name  (tax-code)`. Kept tight so prompt caching
 * pays for itself quickly.
 */
export function formatChartForPrompt(entity: Entity): string {
  const chart = getChart(entity);
  const byType = new Map<string, AccountRow[]>();
  for (const row of chart) {
    const arr = byType.get(row.type) ?? [];
    arr.push(row);
    byType.set(row.type, arr);
  }

  const sortedTypes = Array.from(byType.keys()).sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a);
    const ib = TYPE_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const entityName =
    entity === "SC"
      ? "Just Better Care Sunshine Coast Pty Ltd"
      : "Just Better Care Central Queensland Pty Ltd";

  const lines: string[] = [];
  lines.push(`## ${entity} CHART OF ACCOUNTS (${entityName})`);
  lines.push(
    `Postable accounts only. Use ONLY codes from this list — if nothing fits, ` +
      `set cannot_propose=true with reason "no matching account code" rather ` +
      `than inventing one. Format: \`code  name  (tax)\`.`,
  );
  lines.push("");

  for (const type of sortedTypes) {
    const rows = byType.get(type) ?? [];
    if (rows.length === 0) continue;
    lines.push(`### ${type}`);
    for (const r of rows) {
      lines.push(`${r.code}  ${r.name}  (${shortTax(r.taxCode)})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
