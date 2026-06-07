// POST /api/payroll-journal/post — create the Xero DRAFT for a stored upload.
//
// Mark holds NO Xero keys. This route forwards the previously-uploaded 3-file
// set to the payroll-poster service (which holds the keys + the verified
// parser, and is HARD-LOCKED to DRAFT). It does NOT build the journal itself —
// one builder, the deterministic parser.
//
// Body (application/json): { uploadId: string, journalDate?: string, narration?: string }
// Returns the poster's result (SC + CQ draft links) and marks the upload posted.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { sendPaygEmail, type PaygSide } from "@/lib/payroll-payg-email";

export const dynamic = "force-dynamic";
export const maxDuration = 200;

export async function POST(req: NextRequest) {
  if (!env.PAYROLL_POSTER_URL || !env.PAYROLL_POSTER_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "payroll-poster not configured (PAYROLL_POSTER_URL / PAYROLL_POSTER_API_KEY)" },
      { status: 500 },
    );
  }

  let body: { uploadId?: string; journalDate?: string; narration?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.uploadId) {
    return NextResponse.json({ ok: false, error: "uploadId required" }, { status: 400 });
  }

  const up = await prisma.payrollUpload.findUnique({ where: { id: body.uploadId } });
  if (!up) {
    return NextResponse.json({ ok: false, error: "upload not found" }, { status: 404 });
  }
  if (up.posted) {
    return NextResponse.json({ ok: false, error: "this upload was already posted" }, { status: 409 });
  }

  // Build a multipart form with the three stored files.
  const fd = new FormData();
  fd.append("summary", new Blob([new Uint8Array(up.summaryBytes as Buffer)]), up.summaryName);
  fd.append("data", new Blob([new Uint8Array(up.dataBytes as Buffer)]), up.dataName);
  fd.append("detail", new Blob([new Uint8Array(up.detailBytes as Buffer)]), up.detailName);
  if (body.journalDate) fd.append("journal_date", body.journalDate);
  if (body.narration) fd.append("narration", body.narration);

  const url = `${env.PAYROLL_POSTER_URL.replace(/\/+$/, "")}/post`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PAYROLL_POSTER_API_KEY}` },
      body: fd,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `could not reach payroll-poster: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const json = (await resp.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
  if (!resp.ok || !json.ok) {
    return NextResponse.json(
      { ok: false, error: json.error || `poster returned HTTP ${resp.status}`, detail: json },
      { status: 502 },
    );
  }

  await prisma.payrollUpload.update({
    where: { id: up.id },
    data: { posted: true, postedAt: new Date() },
  });

  // ── PAYG email — fire-and-forget, never block the API response. ──
  // Tony has been getting this email from jbc-compliance for months; the
  // workflow's now on Mark so the email needs to come from here too.
  let emailResult: { sent: boolean; skippedReason?: string } = { sent: false, skippedReason: "no SC/CQ posted result" };
  try {
    const r = json.result as {
      meta?: { pay_period_from?: string; pay_period_to?: string; journal_date?: string; sc_runs?: string[]; cq_runs?: string[] };
      sc?: { payg?: number; super_sg?: number; net_pay?: number; total_dr?: number } | null;
      cq?: { payg?: number; super_sg?: number; net_pay?: number; total_dr?: number } | null;
      posted?: {
        sc?: { ManualJournalID?: string; xero_link?: string } | null;
        cq?: { ManualJournalID?: string; xero_link?: string } | null;
      };
    };
    const meta = r?.meta ?? {};
    const buildSide = (
      totals: { payg?: number; super_sg?: number; net_pay?: number; total_dr?: number } | null | undefined,
      posted: { ManualJournalID?: string; xero_link?: string } | null | undefined,
      runs: string[] | undefined,
    ): PaygSide | null => {
      if (!totals || !posted || !posted.ManualJournalID || !posted.xero_link) return null;
      return {
        payg: totals.payg ?? 0,
        superSg: totals.super_sg ?? 0,
        netPay: totals.net_pay ?? 0,
        totalDr: totals.total_dr ?? 0,
        journalId: posted.ManualJournalID,
        xeroLink: posted.xero_link,
        runs: runs ?? [],
      };
    };
    const sc = buildSide(r?.sc ?? null, r?.posted?.sc ?? null, meta.sc_runs);
    const cq = buildSide(r?.cq ?? null, r?.posted?.cq ?? null, meta.cq_runs);
    if (sc || cq) {
      emailResult = await sendPaygEmail({
        payPeriodFrom: meta.pay_period_from ?? "",
        payPeriodTo: meta.pay_period_to ?? "",
        journalDate: meta.journal_date ?? "",
        sc,
        cq,
      });
    }
  } catch (e) {
    emailResult = { sent: false, skippedReason: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({ ok: true, result: json.result, email: emailResult });
}
