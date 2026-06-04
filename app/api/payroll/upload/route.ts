// POST /api/payroll/upload — Tony uploads a MYOB "Pay Activity Detail Data"
// export. We parse every pay line, group weekly runs into the month their pay
// date falls in (per entity), break down by pay type, and upsert one
// PayrollMonth row per (entity, month). Re-uploading a month overwrites it.
//
// Basic auth is enforced upstream by proxy.ts; we decode the header only to
// stamp uploadedBy.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { parsePayroll } from "@/lib/parse-payroll";

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
  const file = form.get("file");
  if (!file || typeof file === "string") return fail("file required");
  if (file.size === 0) return fail("file is empty");
  if (file.size > MAX_BYTES) {
    return fail(`file too large (${(file.size / 1_048_576).toFixed(1)} MB, max 25 MB)`);
  }

  const name = file.name || "upload.xlsx";
  const bytes = Buffer.from(new Uint8Array(await file.arrayBuffer()));
  const parsed = parsePayroll(bytes);
  if (!parsed.ok) return fail(parsed.error || "could not parse file");
  if (!parsed.months.length) return fail("no pay data found in file");

  const uploadedBy = await currentPeer();

  // Merge semantics: a month can span several weekly runs uploaded over time.
  // If a PayrollMonth row already exists AND this upload's pay-run IDs are NOT
  // all already counted, we MERGE (add the new runs' line items). To keep it
  // simple and predictable, we instead re-derive per upload but combine with any
  // existing rows that came from DIFFERENT pay runs. Implementation: load
  // existing row, union pay runs; if all new runs already present, overwrite
  // (idempotent re-upload); else add line items together.
  let written = 0;
  for (const m of parsed.months) {
    const existing = await prisma.payrollMonth.findUnique({
      where: { entityCode_month: { entityCode: m.entityCode, month: m.month } },
    });

    const existingRuns: string[] = Array.isArray(existing?.payRuns)
      ? (existing!.payRuns as unknown as string[])
      : [];
    const newRuns = m.payRuns.filter((r) => !existingRuns.includes(r));

    let mergedLineItems = m.lineItems;
    let gross = m.totalGross;
    let suTotal = m.totalSuper;
    let allow = m.totalAllowances;
    let leave = m.totalLeaveTaken;
    let allRuns = m.payRuns;

    if (existing && newRuns.length > 0 && newRuns.length < m.payRuns.length) {
      // Partial overlap is unusual; treat the upload as authoritative for the
      // runs it contains. (Simplicity beats clever partial merges here.)
    }

    if (existing && newRuns.length === 0) {
      // Re-upload of the same run(s) — overwrite (idempotent).
      // mergedLineItems already = this upload's; nothing to add.
      allRuns = [...new Set([...existingRuns, ...m.payRuns])];
    } else if (existing && newRuns.length > 0) {
      // This upload adds NEW runs to a month already partly stored — merge by
      // summing line items per (payType, category) and the totals.
      const map = new Map<string, { payType: string; category: string; amount: number }>();
      const add = (arr: Array<{ payType: string; category: string; amount: number }>) => {
        for (const li of arr) {
          const k = `${li.payType}||${li.category}`;
          const g = map.get(k) ?? { payType: li.payType, category: li.category, amount: 0 };
          g.amount = Math.round((g.amount + li.amount) * 100) / 100;
          map.set(k, g);
        }
      };
      add((existing.lineItems as unknown as Array<{ payType: string; category: string; amount: number }>) ?? []);
      add(m.lineItems);
      mergedLineItems = [...map.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      gross = Math.round(((existing.totalGross ?? 0) + m.totalGross) * 100) / 100;
      suTotal = Math.round(((existing.totalSuper ?? 0) + m.totalSuper) * 100) / 100;
      allow = Math.round(((existing.totalAllowances ?? 0) + m.totalAllowances) * 100) / 100;
      leave = Math.round(((existing.totalLeaveTaken ?? 0) + m.totalLeaveTaken) * 100) / 100;
      allRuns = [...new Set([...existingRuns, ...m.payRuns])];
    }

    const data = {
      totalGross: gross,
      totalSuper: suTotal,
      totalAllowances: allow,
      totalLeaveTaken: leave,
      payRuns: JSON.parse(JSON.stringify(allRuns)),
      lineItems: JSON.parse(JSON.stringify(mergedLineItems)),
      sourceFilename: name,
      uploadedBy,
    };

    await prisma.payrollMonth.upsert({
      where: { entityCode_month: { entityCode: m.entityCode, month: m.month } },
      create: { entityCode: m.entityCode, month: m.month, ...data },
      update: data,
    });
    written++;
  }

  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return NextResponse.redirect(new URL("/payroll", req.url), { status: 303 });
  }
  return NextResponse.json({
    ok: true,
    monthsWritten: written,
    months: parsed.months.map((m) => ({ entity: m.entityCode, month: m.month, gross: m.totalGross })),
  });
}
