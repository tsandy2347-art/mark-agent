// In-chat JBC payroll-journal tool for Mark's /qa.
//
// Mark calls create_payroll_journal only after the user has typed an
// explicit YES confirming the per-(entity × directness) totals + chart
// codes he proposed in the prior turn. The tool POSTs to recon's
// /api/journals/payroll-draft with Bearer HUB_API_KEY + x-triggered-by;
// recon owns the JBC-pattern build (SC + WB Location-tracked + 877
// clearing for SC tenant; no tracking for CQ tenant) and the audit log.
//
// Status is hard-locked DRAFT at the recon write layer — there is no
// path here that creates an AUTHORISED (posted) journal.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

export const CREATE_PAYROLL_JOURNAL_TOOL: Anthropic.Messages.Tool = {
  name: "create_payroll_journal",
  description:
    "Create JBC payroll DRAFT manual journals in Xero — one per tenant " +
    "(SC and CQ). SC tenant journal contains SC + Wide Bay lines split by " +
    "Xero `Location` tracking + 877 Tracking Transfers clearing, per Craig's " +
    "historical pattern (Journal #673782). CQ tenant journal is single " +
    "location, no tracking. STATUS IS HARD-LOCKED TO DRAFT at the recon write " +
    "layer — there is no path here that creates a POSTED journal.\n\n" +
    "ONLY CALL THIS TOOL after the user has typed an explicit YES (or 'yes', " +
    "'yes do it', 'go ahead', 'create them', 'create the drafts') confirming " +
    "the totals + codes you proposed in YOUR prior assistant turn. If the user " +
    "hasn't confirmed yet, propose the journal inline and ASK for confirmation " +
    "— do NOT call this tool.\n\n" +
    "Each totals bucket carries the seven MYOB columns: gross, preTaxDed, " +
    "payg, afterTax, postTaxDed, net, employerSuper. ALL FIVE NUMBER COLUMNS " +
    "MUST RECONCILE to MYOB's row-8 grand totals AND to: " +
    "Net = Gross − PreTaxDed − PAYG + AfterTax − PostTaxDed (the script will " +
    "reject if DR != CR within 1c).\n\n" +
    "Direct vs Indirect: MYOB 'Field' department = Direct. ALL OTHER " +
    "departments (Admin / Management / Finance / HR / Rostering / HCP / " +
    "HCP Admin / NDIS Disability / NDIS SIL) = Indirect. Caller is responsible " +
    "for the classification.",
  input_schema: {
    type: "object",
    properties: {
      payPeriodStart: { type: "string", description: "Pay period start date, yyyy-mm-dd." },
      payPeriodEnd:   { type: "string", description: "Pay period end date, yyyy-mm-dd." },
      journalDate:    { type: "string", description: "Date on each journal line, yyyy-mm-dd. Usually payPeriodEnd." },
      narration:      {
        type: "string",
        description:
          "Free-text narration that appears in Xero. Convention is " +
          "'Payrun<NNNN> we <DDMM>' (e.g. 'Payrun1910 we 1904') matching " +
          "Craig's pattern — include the MYOB pay-run ID so Nicole can " +
          "trace it back.",
      },
      totals: {
        type: "object",
        description:
          "Per-(entity × directness) totals from the MYOB Pay Activity Summary. " +
          "Include only the buckets that have data — empty buckets are omitted, " +
          "not passed as zero.",
        properties: {
          SC_DIRECT:   { $ref: "#/$defs/totalsBlock" },
          SC_INDIRECT: { $ref: "#/$defs/totalsBlock" },
          WB_DIRECT:   { $ref: "#/$defs/totalsBlock" },
          WB_INDIRECT: { $ref: "#/$defs/totalsBlock" },
          CQ_DIRECT:   { $ref: "#/$defs/totalsBlock" },
          CQ_INDIRECT: { $ref: "#/$defs/totalsBlock" },
        },
      },
      codes: {
        type: "object",
        description: "Override JBC chart codes. Defaults to 477/477.4/478/478.1/803/825/826/877 per Craig's pattern.",
        properties: {
          wagesDirect:   { type: "string" },
          wagesIndirect: { type: "string" },
          superDirect:   { type: "string" },
          superIndirect: { type: "string" },
          wagesPayable:  { type: "string" },
          paygPayable:   { type: "string" },
          superPayable:  { type: "string" },
          trackingXfer:  { type: "string" },
        },
      },
      scTracking: {
        type: "object",
        description: "Override SC Xero Location tracking names. Defaults to category='Location' / options='Sunshine Coast' + 'Wide Bay'.",
        properties: {
          categoryName: { type: "string" },
          scOptionName: { type: "string" },
          wbOptionName: { type: "string" },
        },
      },
    },
    required: ["payPeriodStart", "payPeriodEnd", "narration", "totals"],
    $defs: {
      totalsBlock: {
        type: "object",
        description: "MYOB Pay Activity Summary columns for this (entity × directness) bucket. All values in AUD, all positive. Net must equal Gross − PreTaxDed − PAYG + AfterTax − PostTaxDed.",
        properties: {
          gross:          { type: "number" },
          preTaxDed:      { type: "number" },
          payg:           { type: "number" },
          afterTax:       { type: "number" },
          postTaxDed:     { type: "number" },
          net:            { type: "number" },
          employerSuper:  { type: "number" },
        },
        required: ["gross", "payg", "net", "employerSuper"],
      },
    },
  },
};

export interface PayrollToolInput {
  payPeriodStart?: unknown;
  payPeriodEnd?: unknown;
  journalDate?: unknown;
  narration?: unknown;
  totals?: unknown;
  codes?: unknown;
  scTracking?: unknown;
}

export interface PayrollToolResult {
  ok: boolean;
  triggeredBy?: string;
  sc?: {
    posted: boolean;
    manualJournalId?: string;
    xeroLink?: string;
    writeLogId?: string;
    errorMessage?: string;
    totalDr?: number;
    totalCr?: number;
    lineCount?: number;
  };
  cq?: {
    posted: boolean;
    manualJournalId?: string;
    xeroLink?: string;
    writeLogId?: string;
    errorMessage?: string;
    totalDr?: number;
    totalCr?: number;
    lineCount?: number;
  };
  error?: string;
}

/** Forward the tool's input verbatim to recon's /api/journals/payroll-draft.
 *  Recon does all the validation, builds the lines, posts to Xero, audit-logs.
 *  Mark just routes the call + identity. */
export async function executePayrollJournalTool(args: {
  input: PayrollToolInput;
  triggeredBy: string;
}): Promise<PayrollToolResult> {
  if (!env.SPECIALIST_RECONCILIATION_URL) {
    return { ok: false, error: "SPECIALIST_RECONCILIATION_URL not configured on Mark" };
  }
  if (!env.HUB_API_KEY) {
    return { ok: false, error: "HUB_API_KEY not configured on Mark" };
  }

  const url = `${env.SPECIALIST_RECONCILIATION_URL.replace(/\/$/, "")}/api/journals/payroll-draft`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.HUB_API_KEY}`,
        "x-triggered-by": args.triggeredBy,
      },
      body: JSON.stringify(args.input),
    });
  } catch (e) {
    return { ok: false, error: `failed to reach reconciliation agent: ${e instanceof Error ? e.message : String(e)}` };
  }

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return {
      ok: false,
      error: (json as { error?: string }).error ?? `recon returned HTTP ${resp.status}`,
    };
  }
  const j = json as {
    triggeredBy?: string;
    sc?: PayrollToolResult["sc"];
    cq?: PayrollToolResult["cq"];
  };
  return {
    ok: true,
    triggeredBy: j.triggeredBy,
    sc: j.sc,
    cq: j.cq,
  };
}
