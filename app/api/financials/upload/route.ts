// POST /api/financials/upload — Tony uploads a Xero "Profit and Loss"
// (compared by month) export for one entity. We parse every month column and
// upsert it into MonthlyFinancials so Mark answers history from his own DB
// instead of re-pulling closed months from Xero (which burns the daily API cap).
//
// Basic auth is enforced upstream by proxy.ts; we decode the header only to
// stamp uploadedBy for the audit trail.
//
// Multipart form fields:
//   - entityCode  "SC" | "CQ"   (required)
//   - file        the Xero P&L xlsx/csv (required, <= 25 MB)

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { parseProfitAndLoss } from "@/lib/parse-pl";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_BYTES = 25 * 1024 * 1024;

async function currentPeer(): Promise<string> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth?.startsWith("Basic ")) return "user:anonymous";
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const user = decoded.split(":")[0].toLowerCase();
    return `user:${user || "anonymous"}`;
  } catch {
    return "user:anonymous";
  }
}

function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    return fail("Content-Type must be multipart/form-data");
  }

  const form = await req.formData();
  const entityCode = String(form.get("entityCode") ?? "").trim().toUpperCase();
  const file = form.get("file");

  if (entityCode !== "SC" && entityCode !== "CQ") {
    return fail('entityCode must be "SC" or "CQ"');
  }
  if (!file || typeof file === "string") return fail("file required");
  if (file.size === 0) return fail("file is empty");
  if (file.size > MAX_BYTES) {
    return fail(`file too large (${(file.size / 1_048_576).toFixed(1)} MB, max 25 MB)`);
  }

  const name = file.name || "upload";
  const ext = name.toLowerCase().endsWith(".csv")
    ? "csv"
    : name.toLowerCase().endsWith(".xls")
      ? "xls"
      : "xlsx";

  const bytes = Buffer.from(new Uint8Array(await file.arrayBuffer()));
  const parsed = parseProfitAndLoss(bytes, ext);
  if (!parsed.ok) {
    return fail(parsed.error || "could not parse file");
  }
  if (!parsed.months.length) {
    return fail("no month columns found in the file");
  }

  const uploadedBy = await currentPeer();

  // Upsert each parsed month. Re-uploading overwrites (restatements welcome).
  let written = 0;
  for (const m of parsed.months) {
    await prisma.monthlyFinancials.upsert({
      where: { entityCode_month: { entityCode, month: m.month } },
      create: {
        entityCode,
        month: m.month,
        totalIncome: m.totalIncome,
        totalCostOfSales: m.totalCostOfSales,
        grossProfit: m.grossProfit,
        totalOtherIncome: m.totalOtherIncome,
        totalOperatingExpenses: m.totalOperatingExpenses,
        netProfit: m.netProfit,
        sourceFilename: name,
        uploadedBy,
      },
      update: {
        totalIncome: m.totalIncome,
        totalCostOfSales: m.totalCostOfSales,
        grossProfit: m.grossProfit,
        totalOtherIncome: m.totalOtherIncome,
        totalOperatingExpenses: m.totalOperatingExpenses,
        netProfit: m.netProfit,
        sourceFilename: name,
        uploadedBy,
      },
    });
    written++;
  }

  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return NextResponse.redirect(new URL("/financials", req.url), { status: 303 });
  }
  return NextResponse.json({
    ok: true,
    entityCode,
    monthsWritten: written,
    range: { from: parsed.months[parsed.months.length - 1].month, to: parsed.months[0].month },
    entityGuess: parsed.entityGuess,
  });
}
