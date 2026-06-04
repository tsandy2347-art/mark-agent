// lib/parse-payroll.ts — Parse a MYOB "Pay Activity Detail Data" export (XLSX)
// into a per-entity, per-month, per-pay-type wage breakdown for Mark.
//
// WHY: payroll holds the only line-by-line view of labour cost — ordinary hours,
// overtime, casual loading, weekend/shift loadings, travel, leave, super,
// allowances. The P&L only shows a single "Wages" lump. Feeding Mark this
// breakdown lets him answer real CFO questions: "how much overtime did SC pay in
// May", "what are we spending on travel allowances", "super for the month".
//
// MYOB LAYOUT (verified against a real export, June 2026):
//   Sheet "Data", row 1 = headers, then one row per pay-item line:
//     Pay Run ID | Pay Run Description | Pay Date | Status | Employee ID |
//     First Name | Last Name | Pay Item ID | Pay Item Description | Type |
//     Qty | Units | Percent | Rate | Amount
//   - Pay Run Description carries the ENTITY: "Weekly Central Queensland" = CQ,
//     anything else (e.g. "Weekly Sunshine Coast & Wide Bay") = SC.
//   - Pay Date is an Excel serial; the MONTH it falls in is the bucket (Tony's
//     choice: group weekly runs into months to match the P&L view).
//   - Pay Item Description is messy: "Ordinary Hours - 19", "Casual Loading
//     (25%) - 16", trailing employee codes. We NORMALISE to a family name so
//     all the "Ordinary Hours - NN" variants collapse into one "Ordinary Hours".
//   - Type buckets: Income (actual wage cost), Allowance, Employer Super,
//     Employee Super, Entitlement Accrual (leave accruing — NOT cash this run),
//     Entitlement Payment (leave actually taken), Deduction.
//
// We DON'T need cents-perfect reconciliation to a journal — this is for insight,
// so we keep it simple and group by (entity, month, payType, type).

import { inflateRawSync } from "zlib";

export interface PayrollLine {
  payType: string; // normalised family, e.g. "Ordinary Hours", "Overtime (2x)"
  category: string; // MYOB Type: Income | Allowance | Employer Super | ...
  amount: number;
}

export interface ParsedPayrollMonth {
  entityCode: "SC" | "CQ";
  month: string; // "YYYY-MM" the pay dates fall in
  payRuns: string[]; // pay-run IDs rolled into this month (audit)
  totalGross: number; // sum of Income-type lines (actual wage cost)
  totalSuper: number; // Employer Super
  totalAllowances: number; // Allowance
  totalLeaveTaken: number; // Entitlement Payment
  lineItems: PayrollLine[]; // grouped (payType, category) amounts, biggest first
}

export interface ParsePayrollResult {
  ok: boolean;
  error?: string;
  months: ParsedPayrollMonth[];
}

const MONTHS_NUM = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

/** Excel serial date → "YYYY-MM" (Brisbane has no DST; date-only is safe). */
function serialToMonth(serial: unknown): string | null {
  const n = typeof serial === "number" ? serial : parseFloat(String(serial));
  if (!isFinite(n)) return null;
  // Excel epoch 1899-12-30.
  const ms = Date.UTC(1899, 11, 30) + n * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${MONTHS_NUM[d.getUTCMonth()]}`;
}

function num(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").replace(/[, ]/g, ""));
  return isFinite(n) ? n : 0;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Collapse MYOB's noisy pay-item descriptions into a stable family name:
 *   "Ordinary Hours - 19"        -> "Ordinary Hours"
 *   "Casual Loading (25%) - 16"  -> "Casual Loading (25%)"
 *   "Ordinary base rate C1SC001774" -> "Ordinary base rate"
 *   "Casual Loading."            -> "Casual Loading" (trailing dot)
 */
export function normalisePayType(desc: string): string {
  let d = (desc ?? "").trim();
  d = d.replace(/\s+[A-Z0-9]{6,}$/, ""); // trailing employee code
  d = d.replace(/\s*-\s*\d+$/, ""); // trailing "- 19"
  d = d.replace(/\.$/, ""); // trailing dot
  return d.trim();
}

function entityOf(desc: string): "SC" | "CQ" {
  return /central queensland/i.test(desc ?? "") ? "CQ" : "SC";
}

const COL = {
  payRunId: 0,
  payRunDesc: 1,
  payDate: 2,
  payItemDesc: 8,
  type: 9,
  amount: 14,
};

// ── Self-contained XLSX reader ──────────────────────────────────────────────
// MYOB's export omits the `r` (cell reference) attribute on cells, which makes
// SheetJS's range computation throw ("invalid column -1"). So we read the .xlsx
// (a ZIP of XML) ourselves: walk <row>/<c> in document order, decode inline +
// shared strings, and build a positional grid. Robust to the missing refs.

/** Minimal ZIP reader for the stored/deflated entries in an .xlsx. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // Find End Of Central Directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return files;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    // Local header: recompute data start (local name/extra lengths differ).
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    } catch {
      data = Buffer.alloc(0);
    }
    files.set(name, data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Read the first sheet matching /data/i (or sheet1) as a positional grid. */
function readXlsxGrid(bytes: Buffer): unknown[][] | null {
  const zip = readZip(bytes);
  if (!zip.size) return null;

  // Shared strings.
  const shared: string[] = [];
  const ss = zip.get("xl/sharedStrings.xml");
  if (ss) {
    const xml = ss.toString("utf8");
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join("");
      shared.push(text);
    }
  }

  // Pick the sheet: map workbook sheet name -> rId -> target path. Simplest:
  // try the "Data" sheet via workbook + rels, fall back to sheet1.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wbXml = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const relsXml = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const sheetMatch = [...wbXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)];
  const dataSheet = sheetMatch.find((s) => /data/i.test(s[1]));
  if (dataSheet) {
    const rid = dataSheet[2];
    const rel = relsXml.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`));
    if (rel) sheetPath = rel[1].startsWith("/") ? rel[1].slice(1) : `xl/${rel[1]}`;
  }
  const sheetXml = zip.get(sheetPath)?.toString("utf8") ?? zip.get("xl/worksheets/sheet1.xml")?.toString("utf8");
  if (!sheetXml) return null;

  const grid: unknown[][] = [];
  // Column letters → 0-based index. "A"->0, "AB"->27.
  const colIndex = (ref: string): number => {
    const letters = (ref.match(/^[A-Za-z]+/) || [""])[0].toUpperCase();
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  // Split a row's inner XML into individual <c ...>...</c> or <c .../> cells.
  // CRITICAL: cells may be self-closing (empty) and MYOB omits some, so we
  // place each value by its `r` column reference — never by document position.
  const cellRe = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (const rowM of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: unknown[] = [];
    for (const cM of rowM[1].matchAll(cellRe)) {
      const attrs = cM[1] ?? "";
      const body = cM[2] ?? "";
      const ref = (attrs.match(/r="([^"]+)"/) || [])[1];
      const t = (attrs.match(/t="([^"]+)"/) || [])[1];
      let val: unknown = null;
      if (t === "inlineStr") {
        val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1])).join("");
      } else {
        const v = (body.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (v != null) {
          if (t === "s") val = shared[Number(v)] ?? "";
          else if (t === "str") val = decodeEntities(v);
          else val = Number(v);
        }
      }
      const idx = ref ? colIndex(ref) : cells.length;
      cells[idx] = val;
    }
    grid.push(cells);
  }
  return grid;
}

export function parsePayroll(bytes: Buffer): ParsePayrollResult {
  const rows = readXlsxGrid(bytes);
  if (!rows) {
    return { ok: false, error: "could not read the spreadsheet (not a valid .xlsx?)", months: [] };
  }

  if (rows.length < 2) return { ok: false, error: "file has no data rows", months: [] };

  // Validate it looks like a Pay Activity Detail export.
  const header = (rows[0] || []).map((c) => String(c ?? "").toLowerCase());
  const looksRight = header.some((h) => h.includes("pay item")) && header.some((h) => h.includes("pay run"));
  if (!looksRight) {
    return {
      ok: false,
      error: 'this doesn\'t look like a MYOB "Pay Activity Detail Data" export (no Pay Item / Pay Run columns)',
      months: [],
    };
  }

  // bucket[entity][month] -> accumulator
  type Bucket = {
    payRuns: Set<string>;
    grouped: Map<string, { payType: string; category: string; amount: number }>;
    gross: number;
    super: number;
    allowances: number;
    leaveTaken: number;
  };
  const buckets = new Map<string, Bucket>();
  const keyOf = (e: string, m: string) => `${e}|${m}`;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const desc = String(r[COL.payRunDesc] ?? "");
    const month = serialToMonth(r[COL.payDate]);
    if (!month) continue;
    const entity = entityOf(desc);
    const category = String(r[COL.type] ?? "").trim();
    const payType = normalisePayType(String(r[COL.payItemDesc] ?? ""));
    const amount = num(r[COL.amount]);
    if (!payType && !amount) continue;

    const k = keyOf(entity, month);
    let b = buckets.get(k);
    if (!b) {
      b = { payRuns: new Set(), grouped: new Map(), gross: 0, super: 0, allowances: 0, leaveTaken: 0 };
      buckets.set(k, b);
    }
    if (r[COL.payRunId]) b.payRuns.add(String(r[COL.payRunId]));

    const gk = `${payType}||${category}`;
    const g = b.grouped.get(gk) ?? { payType, category, amount: 0 };
    g.amount += amount;
    b.grouped.set(gk, g);

    if (category === "Income") b.gross += amount;
    else if (category === "Employer Super") b.super += amount;
    else if (category === "Allowance") b.allowances += amount;
    else if (category === "Entitlement Payment") b.leaveTaken += amount;
  }

  const months: ParsedPayrollMonth[] = [];
  for (const [k, b] of buckets) {
    const [entity, month] = k.split("|");
    const lineItems: PayrollLine[] = [...b.grouped.values()]
      .map((g) => ({ payType: g.payType, category: g.category, amount: r2(g.amount) }))
      .filter((l) => Math.abs(l.amount) > 0.005)
      .sort((a, b2) => Math.abs(b2.amount) - Math.abs(a.amount));
    months.push({
      entityCode: entity as "SC" | "CQ",
      month,
      payRuns: [...b.payRuns],
      totalGross: r2(b.gross),
      totalSuper: r2(b.super),
      totalAllowances: r2(b.allowances),
      totalLeaveTaken: r2(b.leaveTaken),
      lineItems,
    });
  }
  // Sort newest first for predictable display.
  months.sort((a, b) => (a.entityCode === b.entityCode ? b.month.localeCompare(a.month) : a.entityCode.localeCompare(b.entityCode)));

  if (!months.length) return { ok: false, error: "no pay lines with valid dates found", months: [] };
  return { ok: true, months };
}
