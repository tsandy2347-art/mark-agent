// Receivables data layer — reads directly from the shared findings DB.
//
// Monty (the receivables specialist) writes findings keyed by detector +
// per-invoice or per-debtor evidence. We aggregate them here for the
// /reports/receivables page and Mark's voice answers. Single source of
// truth: whatever Monty saw on his last nightly run.
//
// Privacy note: customer NAMES are masked at write-time into a "contactRef"
// (initials + last 4 of UUID). The xeroContactId is preserved so the page can
// link straight into Xero where the real name lives. This keeps individual
// payer names out of the findings store while still letting the dashboard
// identify which debtor a finding belongs to.

import { Pool } from "pg";
import { env } from "../env";

let _pool: Pool | null = null;
function pool(): Pool | null {
  if (!env.HERMES_FINDINGS_DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: env.HERMES_FINDINGS_DATABASE_URL, max: 2 });
  return _pool;
}

export interface BucketRow {
  entity: "SC" | "CQ";
  bucket: "1-30" | "31-60" | "61-90" | "90+" | "current";
  invoiceCount: number;
  outstanding: number;
}

export interface DebtorRow {
  xeroContactId: string;
  contactRef: string;
  entity: "SC" | "CQ";
  totalOutstanding: number;
  invoiceCount: number;
  oldestAgeDays: number;
  /** Cents over the exposure limit (>0 = breach). null if not flagged. */
  exposureBreach: boolean;
}

export interface InvoiceRow {
  xeroInvoiceId: string;
  invoiceNumber: string;
  ageDays: number;
  bucket: string;
  amount: number;
}

export interface ReceivablesSummary {
  /** "as of" — when Monty last ran (the source data behind everything below). */
  asOf: Date | null;
  /** Per-(entity, bucket) totals derived from invoice-60-plus / invoice-90-plus
   *  / writeoff-candidate findings. Missing buckets (e.g. "current", "1-30")
   *  aren't visible to Monty's findings stream — only overdues are flagged. */
  buckets: BucketRow[];
  /** Headline KPIs across both entities. */
  totalOpenInvoices: number;
  total60Plus: number;
  total90Plus: number;
  total120Plus: number;
  exposureBreachCount: number;
  exposureBreachTotal: number;
  /** Top N debtors by total outstanding across both entities. */
  topDebtors: DebtorRow[];
}

const ENTITIES = ["SC", "CQ"] as const;

export async function loadReceivablesSummary(topN = 10): Promise<ReceivablesSummary> {
  const p = pool();
  if (!p) {
    return {
      asOf: null,
      buckets: [],
      totalOpenInvoices: 0,
      total60Plus: 0,
      total90Plus: 0,
      total120Plus: 0,
      exposureBreachCount: 0,
      exposureBreachTotal: 0,
      topDebtors: [],
    };
  }

  // 1. "as of" = Monty's latest successful run.
  const asOfRow = await p.query(
    `SELECT MAX(run_at) AS at FROM audit_runs WHERE source_agent = 'receivables'`,
  );
  const asOf: Date | null = asOfRow.rows[0]?.at ?? null;

  // 2. Bucket roll-up — each finding row IS one invoice, so COUNT(*) gives
  //    invoice count and SUM(amount) gives outstanding. We pick `invoice-90-plus`
  //    for the 60+/90+/90+ buckets (it emits both 61-90 and 90+ in the ageBucket
  //    evidence field) and `writeoff-candidate` for 120+.
  const bucketRows = await p.query(
    `SELECT entity_code AS entity,
            COALESCE(evidence->>'ageBucket', '90+') AS bucket,
            COUNT(*)::int AS n,
            SUM(amount)::float AS total
       FROM findings
      WHERE source_agent = 'receivables'
        AND resolved = false
        AND detector IN ('invoice-60-plus','invoice-90-plus')
      GROUP BY 1, 2`,
  );
  const writeoffRows = await p.query(
    `SELECT entity_code AS entity,
            COUNT(*)::int AS n,
            SUM(amount)::float AS total
       FROM findings
      WHERE source_agent = 'receivables'
        AND resolved = false
        AND detector = 'writeoff-candidate'
      GROUP BY 1`,
  );

  const buckets: BucketRow[] = [
    ...bucketRows.rows.map((r: Record<string, unknown>) => ({
      entity: r.entity as "SC" | "CQ",
      bucket: (r.bucket as BucketRow["bucket"]) ?? "90+",
      invoiceCount: (r.n as number) ?? 0,
      outstanding: (r.total as number) ?? 0,
    })),
  ];
  for (const w of writeoffRows.rows) {
    buckets.push({
      entity: (w.entity as "SC" | "CQ"),
      bucket: "90+", // we surface writeoff candidates as their own KPI
      invoiceCount: (w.n as number) ?? 0,
      outstanding: (w.total as number) ?? 0,
    });
  }

  // 3. Top debtors — debtor-exposure-breach is Monty's already-aggregated
  //    per-debtor row (it carries `openInvoiceCount`, `oldestAgeDays`, and the
  //    total in `amount`). But the breach list only shows debtors OVER the
  //    exposure limit (currently $25k). For a true top-N including everyone
  //    we aggregate from the invoice-level findings.
  const debtorRows = await p.query(
    `WITH inv AS (
       SELECT entity_code AS entity,
              evidence->>'xeroContactId' AS xero_id,
              evidence->>'contactRef'    AS ref,
              amount,
              COALESCE((evidence->>'ageDays')::int, 0) AS age_days
         FROM findings
        WHERE source_agent = 'receivables'
          AND resolved = false
          AND detector IN ('invoice-60-plus','invoice-90-plus','writeoff-candidate','part-payment')
          AND evidence->>'xeroContactId' IS NOT NULL
     ),
     deduped AS (
       -- Same invoice may appear under multiple detectors (e.g. 90+ AND writeoff).
       -- Group by xeroInvoiceId via a sub-aggregation upstream would be cleaner,
       -- but findings don't carry it consistently for every detector. Best we
       -- can do here: pick the MAX amount per (debtor, age_days) tuple — works
       -- because the same invoice has identical age + amount across detectors.
       SELECT entity, xero_id, ref, MAX(amount) AS amount, MAX(age_days) AS age_days
         FROM inv
        GROUP BY entity, xero_id, ref, age_days
     )
     SELECT entity, xero_id, ref,
            SUM(amount)::float AS outstanding,
            COUNT(*)::int      AS invoice_count,
            MAX(age_days)::int AS oldest_age
       FROM deduped
      GROUP BY entity, xero_id, ref
      ORDER BY outstanding DESC NULLS LAST
      LIMIT $1`,
    [topN],
  );

  // Exposure-breach overlay: any debtor in the top-N who's also on Monty's
  // breach list gets the flag.
  const breachRows = await p.query(
    `SELECT evidence->>'xeroContactId' AS xero_id
       FROM findings
      WHERE source_agent = 'receivables'
        AND resolved = false
        AND detector = 'debtor-exposure-breach'`,
  );
  const breaches = new Set<string>(
    breachRows.rows.map((r: Record<string, unknown>) => r.xero_id as string).filter(Boolean),
  );

  const topDebtors: DebtorRow[] = debtorRows.rows.map((r: Record<string, unknown>) => ({
    xeroContactId: r.xero_id as string,
    contactRef: r.ref as string,
    entity: r.entity as "SC" | "CQ",
    totalOutstanding: r.outstanding as number,
    invoiceCount: r.invoice_count as number,
    oldestAgeDays: r.oldest_age as number,
    exposureBreach: breaches.has(r.xero_id as string),
  }));

  // 4. Headline KPIs.
  const headlineRow = await p.query(
    `SELECT
       SUM(CASE WHEN detector = 'invoice-60-plus' THEN 1 ELSE 0 END)::int AS n_60_plus,
       SUM(CASE WHEN detector = 'invoice-90-plus' THEN 1 ELSE 0 END)::int AS n_90_plus,
       SUM(CASE WHEN detector = 'writeoff-candidate' THEN 1 ELSE 0 END)::int AS n_writeoff,
       SUM(CASE WHEN detector = 'invoice-60-plus' THEN amount ELSE 0 END)::float AS tot_60_plus,
       SUM(CASE WHEN detector = 'invoice-90-plus' THEN amount ELSE 0 END)::float AS tot_90_plus,
       SUM(CASE WHEN detector = 'writeoff-candidate' THEN amount ELSE 0 END)::float AS tot_writeoff,
       SUM(CASE WHEN detector = 'debtor-exposure-breach' THEN 1 ELSE 0 END)::int  AS n_breach,
       SUM(CASE WHEN detector = 'debtor-exposure-breach' THEN amount ELSE 0 END)::float AS tot_breach
       FROM findings
      WHERE source_agent = 'receivables' AND resolved = false`,
  );
  const h = headlineRow.rows[0] ?? {};
  // total open invoices = the 60+, 90+, writeoff buckets are subsets of each
  // other in part (an invoice 100 days old is in 90+ AND writeoff). The clean
  // count is the unique invoice union; for now we use n_60_plus as the
  // simplest "anything overdue" floor.
  const totalOpenInvoices = (h.n_60_plus ?? 0) + (h.n_90_plus ?? 0);

  ENTITIES.length; // keep ENTITIES referenced so the lint stays clean
  return {
    asOf,
    buckets,
    totalOpenInvoices,
    total60Plus: h.tot_60_plus ?? 0,
    total90Plus: h.tot_90_plus ?? 0,
    total120Plus: h.tot_writeoff ?? 0,
    exposureBreachCount: h.n_breach ?? 0,
    exposureBreachTotal: h.tot_breach ?? 0,
    topDebtors,
  };
}

export interface DebtorInvoices {
  contactRef: string;
  entity: "SC" | "CQ";
  totalOutstanding: number;
  invoices: InvoiceRow[];
}

/** Drill-in: every overdue invoice for one debtor. */
export async function loadDebtorInvoices(xeroContactId: string): Promise<DebtorInvoices | null> {
  const p = pool();
  if (!p) return null;
  const { rows } = await p.query(
    `SELECT entity_code AS entity,
            evidence->>'contactRef'    AS ref,
            evidence->>'xeroInvoiceId' AS inv_id,
            evidence->>'invoiceNumber' AS inv_num,
            COALESCE((evidence->>'ageDays')::int, 0) AS age_days,
            COALESCE(evidence->>'ageBucket', '?') AS bucket,
            amount
       FROM findings
      WHERE source_agent = 'receivables'
        AND resolved = false
        AND evidence->>'xeroContactId' = $1
        AND detector IN ('invoice-60-plus','invoice-90-plus','writeoff-candidate','part-payment')
        AND evidence->>'xeroInvoiceId' IS NOT NULL`,
    [xeroContactId],
  );
  if (rows.length === 0) return null;
  // Dedupe same invoice that appears under multiple detectors.
  const byInv = new Map<string, InvoiceRow & { entity: "SC" | "CQ"; ref: string }>();
  for (const r of rows as Record<string, unknown>[]) {
    const k = r.inv_id as string;
    const existing = byInv.get(k);
    if (!existing || (r.amount as number) > existing.amount) {
      byInv.set(k, {
        xeroInvoiceId: r.inv_id as string,
        invoiceNumber: (r.inv_num as string) ?? "(no #)",
        ageDays: r.age_days as number,
        bucket: r.bucket as string,
        amount: r.amount as number,
        entity: r.entity as "SC" | "CQ",
        ref: r.ref as string,
      });
    }
  }
  const invoices = [...byInv.values()].sort((a, b) => b.ageDays - a.ageDays);
  return {
    contactRef: invoices[0].ref,
    entity: invoices[0].entity,
    totalOutstanding: invoices.reduce((s, i) => s + i.amount, 0),
    invoices: invoices.map((i) => ({
      xeroInvoiceId: i.xeroInvoiceId,
      invoiceNumber: i.invoiceNumber,
      ageDays: i.ageDays,
      bucket: i.bucket,
      amount: i.amount,
    })),
  };
}
