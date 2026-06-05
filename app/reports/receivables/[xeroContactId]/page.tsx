// /reports/receivables/[xeroContactId] — per-debtor drill-in.
//
// Lists every outstanding invoice Monty has flagged for one debtor, oldest
// first. The xeroContactId is the same one Xero uses, so opening the matching
// Contact record over there gives you the full history + the legal name (which
// is deliberately masked in our findings store).

import Link from "next/link";
import { loadDebtorInvoices } from "@/lib/mark/receivables";

export const dynamic = "force-dynamic";

function fmtAmount(n: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 2,
  }).format(n);
}

function ageColor(age: number): string {
  if (age >= 120) return "var(--rose)";
  if (age >= 90) return "var(--rose)";
  if (age >= 60) return "var(--amber)";
  return "var(--fg-muted)";
}

export default async function DebtorDrillInPage(
  { params }: { params: Promise<{ xeroContactId: string }> },
) {
  const { xeroContactId } = await params;
  const data = await loadDebtorInvoices(xeroContactId);

  if (!data) {
    return (
      <main className="container">
        <Link href="/reports/receivables" className="muted" style={{ fontSize: 12 }}>← back to receivables</Link>
        <h1 style={{ marginTop: 8 }}>Debtor not found</h1>
        <p className="muted">No overdue invoices on Monty&apos;s latest run for contact <code>{xeroContactId}</code>.</p>
      </main>
    );
  }

  return (
    <main className="container">
      <Link href="/reports/receivables" className="muted" style={{ fontSize: 12 }}>← back to receivables</Link>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0 }}>
            <span className="mono">{data.contactRef}</span>
            <span className="muted mono" style={{ fontSize: 14, marginLeft: 10 }}>({data.entity})</span>
          </h1>
          <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            Names are masked here for privacy. Open <code className="mono" style={{ fontSize: 11 }}>{xeroContactId}</code> in Xero for the legal name.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>Total outstanding</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--rose)" }}>{fmtAmount(data.totalOutstanding)}</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{data.invoices.length} invoices</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18, padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Bucket</th>
              <th style={{ textAlign: "right" }}>Age</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.invoices.map((inv) => (
              <tr key={inv.xeroInvoiceId}>
                <td className="mono" style={{ fontSize: 13 }}>{inv.invoiceNumber}</td>
                <td className="mono" style={{ fontSize: 12, color: ageColor(inv.ageDays) }}>{inv.bucket}</td>
                <td className="mono" style={{ textAlign: "right", fontSize: 12, color: ageColor(inv.ageDays) }}>{inv.ageDays} days</td>
                <td className="mono" style={{ textAlign: "right" }}>{fmtAmount(inv.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
