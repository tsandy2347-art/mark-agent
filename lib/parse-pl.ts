// lib/parse-pl.ts — Parse a Xero "Profit and Loss" export (XLSX or CSV) into
// per-month summary rows for Mark's MonthlyFinancials history book.
//
// WHY THIS EXISTS: Tony exports the 24-month P&L from Xero (Reports → Profit
// and Loss → compare by month) for each entity and uploads it on /financials.
// We parse every month column into income / cost-of-sales / gross profit /
// other income / operating expenses / net profit so Mark can answer profit
// questions for CLOSED months from his own DB — never calling Xero for history.
//
// XERO LAYOUT (verified against a real 24-month SC export, June 2026):
//   Row 1: "Profit and Loss"
//   Row 2: entity legal name
//   Row 3: "For the month ended 30 April 2026"
//   Row 5: header — col A "Account", then alternating "Mon YYYY" value columns
//           and "Mon YYYY % of Trading Income" columns. We use ONLY the value
//           columns (skip the "%" ones).
//   Section label rows in col A: "Trading Income", "Cost of Sales",
//           "Other Income", "Operating Expenses". Leaf account rows sit under
//           each. "Total ..." / "Gross Profit" / "Net Profit" rows are SUM
//           formulas whose cached value Xero exports as 0 — so we DO NOT trust
//           them; we sum the leaf rows ourselves.
//
// QUIRKS handled:
//   - Month names are inconsistent: "Apr 2026", "July 2025", "Sept 2025".
//     We match on the first 3 letters (case-insensitive).
//   - Total/derived rows have stale 0 cached values → recomputed from leaves.
//   - Numbers are strings like "156943.5600" → parseFloat.
//   - The current (partial) month may be present; caller decides whether to
//     store it (we mark it isPartial so the upload route can skip it).

import * as XLSX from "xlsx";

export interface ParsedMonth {
  month: string; // "YYYY-MM"
  label: string; // original header e.g. "Apr 2026"
  totalIncome: number;
  totalCostOfSales: number;
  grossProfit: number;
  totalOtherIncome: number;
  totalOperatingExpenses: number;
  netProfit: number;
}

export interface ParseResult {
  ok: boolean;
  error?: string;
  entityGuess?: string; // legal name from row 2, if present
  months: ParsedMonth[];
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// "Apr 2026" / "July 2025" / "Sept 2025" → "2026-04". Returns null if not a month header.
function toMonthKey(label: string): string | null {
  const m = label.trim().match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  return `${m[2]}-${mon}`;
}

function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[, ]/g, ""));
  return isFinite(n) ? n : 0;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

type SectionField = "totalIncome" | "totalOtherIncome" | "totalCostOfSales" | "totalOperatingExpenses";

const SECTION_KEYS: Record<string, SectionField> = {
  "trading income": "totalIncome",
  "other income": "totalOtherIncome",
  "cost of sales": "totalCostOfSales",
  "operating expenses": "totalOperatingExpenses",
};

/**
 * Parse a Xero P&L workbook (xlsx) or CSV buffer.
 * @param bytes the uploaded file
 * @param ext   "xlsx" | "xls" | "csv" — used to pick the read mode
 */
export function parseProfitAndLoss(bytes: Buffer, ext: string): ParseResult {
  let rows: unknown[][];
  try {
    const wb = XLSX.read(bytes, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { ok: false, error: "no sheet found in file", months: [] };
    rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true, defval: null });
  } catch (e) {
    return { ok: false, error: `could not read file: ${(e as Error).message}`, months: [] };
  }

  if (!rows.length) return { ok: false, error: "file is empty", months: [] };

  // entity legal name is usually row 2 (index 1)
  const entityGuess = typeof rows[1]?.[0] === "string" ? String(rows[1][0]).trim() : undefined;

  // Find the header row: the first row containing at least one "Mon YYYY" cell.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i] || [];
    if (r.some((c) => typeof c === "string" && toMonthKey(c))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { ok: false, error: "could not find a month header row — is this a Xero P&L compared by month?", months: [] };
  }

  // Map header columns to month keys, skipping "% of ..." columns.
  const header = rows[headerIdx] || [];
  const monthCols: { col: number; key: string; label: string }[] = [];
  for (let c = 1; c < header.length; c++) {
    const cell = header[c];
    if (typeof cell !== "string") continue;
    if (cell.includes("%")) continue; // skip "% of Trading Income" columns
    const key = toMonthKey(cell);
    if (key) monthCols.push({ col: c, key, label: cell.trim() });
  }
  if (!monthCols.length) {
    return { ok: false, error: "found a header row but no month value columns", months: [] };
  }

  // Walk the body, tracking the current section, summing leaf rows per column.
  // Initialise accumulators per month.
  type Acc = { income: number; cos: number; otherIncome: number; opex: number };
  const acc: Record<number, Acc> = {};
  for (const mc of monthCols) acc[mc.col] = { income: 0, cos: 0, otherIncome: 0, opex: 0 };

  let section: SectionField | null = null;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const label = typeof r[0] === "string" ? r[0].trim() : "";
    const low = label.toLowerCase();

    if (!label) continue;

    // Section header?
    if (low in SECTION_KEYS) {
      section = SECTION_KEYS[low];
      continue;
    }
    // Total / derived rows — skip (we recompute from leaves).
    if (low.startsWith("total ") || low === "gross profit" || low === "net profit" || low === "surplus") {
      continue;
    }
    // Leaf account row: add its value in each month column to the current section.
    if (!section) continue;
    for (const mc of monthCols) {
      const v = num(r[mc.col]);
      if (!v) continue;
      const a = acc[mc.col];
      if (section === "totalIncome") a.income += v;
      else if (section === "totalCostOfSales") a.cos += v;
      else if (section === "totalOtherIncome") a.otherIncome += v;
      else if (section === "totalOperatingExpenses") a.opex += v;
    }
  }

  const months: ParsedMonth[] = monthCols.map((mc) => {
    const a = acc[mc.col];
    const totalIncome = r2(a.income);
    const totalCostOfSales = r2(a.cos);
    const grossProfit = r2(totalIncome - totalCostOfSales);
    const totalOtherIncome = r2(a.otherIncome);
    const totalOperatingExpenses = r2(a.opex);
    const netProfit = r2(grossProfit + totalOtherIncome - totalOperatingExpenses);
    return {
      month: mc.key,
      label: mc.label,
      totalIncome,
      totalCostOfSales,
      grossProfit,
      totalOtherIncome,
      totalOperatingExpenses,
      netProfit,
    };
  });

  return { ok: true, entityGuess, months };
}
