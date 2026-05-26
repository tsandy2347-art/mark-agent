// Canned per-agent FinanceFinding lists so MARK_MOCK=true exercises the whole
// pipeline (poll → correlate → prioritise → conflict → brief → email) without
// any specialist being up. Useful pre-prod and useful for the smoke-test build.
//
// Designed so the fixtures EXERCISE every code path:
//   - reconciliation: a critical + a cash-position info
//   - controls-audit: a critical vendor-bank-change on the same supplier
//                     payables flagged (cross-agent correlation)
//   - payroll-labour: an isPeopleFlag warning (restricted routing)
//   - payables: a duplicate-invoice on the same supplier as above (correlation)
//   - revenue-claims: an unclaimed-revenue goal input + a warning
//   - receivables: a > $25k overdue (priority=today via amount threshold)
//   - tax-compliance: a cash-set-aside that EXCEEDS the recon cash (conflict #1)
//                     + a net-gst goal input

import type { FinanceFinding, SpecialistAgent } from "../../findings";

const NOW_ISO = "2026-05-26T07:00:00+10:00";

function mk(partial: Partial<FinanceFinding> & Pick<FinanceFinding, "id" | "agent" | "severity" | "title">): FinanceFinding {
  return {
    at: NOW_ISO,
    isPeopleFlag: false,
    entityCode: "SC",
    domain: "",
    detector: partial.detector ?? "mock",
    body: partial.body ?? partial.title,
    explanation: null,
    evidence: {},
    amount: null,
    suggestedAction: "review",
    resolved: false,
    ...partial,
  };
}

const FIXTURES: Record<SpecialistAgent, FinanceFinding[]> = {
  reconciliation: [
    mk({
      id: "recon-1",
      agent: "reconciliation",
      severity: "critical",
      title: "Unreconciled $4,210 SC trust receipt",
      body: "Receipt from APX-9921 not matched to any participant invoice.",
      domain: "bank-rec",
      detector: "unmatched-receipt",
      entityCode: "SC",
      amount: 4210,
      suggestedAction: "review",
      evidence: { invoiceId: null, receiptRef: "APX-9921" },
    }),
    mk({
      id: "recon-cash-sc",
      agent: "reconciliation",
      severity: "info",
      title: "SC cash position $182,400",
      body: "Daily cash position as of 06:30 AEST.",
      domain: "cash",
      detector: "cash-position",
      entityCode: "SC",
      amount: 182400,
      suggestedAction: "monitor",
      evidence: { source: "xero-bank" },
    }),
  ] as FinanceFinding[],

  "controls-audit": [
    mk({
      id: "ctrl-1",
      agent: "controls-audit",
      severity: "critical",
      title: "Vendor bank change on Acme Medical (SC)",
      body: "Bank account changed from ***234 to ***988 on 2026-05-24.",
      domain: "vendor",
      detector: "vendor-bank-change",
      entityCode: "SC",
      amount: null,
      suggestedAction: "freeze",
      evidence: { contactXeroId: "ACME-CONTACT-1", contactName: "Acme Medical" },
    }),
  ] as FinanceFinding[],

  "payroll-labour": [
    mk({
      id: "payroll-1",
      agent: "payroll-labour",
      severity: "warning",
      title: "Off-cycle pay rate change",
      body: "Pay rate adjusted outside the normal review cycle.",
      domain: "pay",
      detector: "off-cycle-rate-change",
      entityCode: "SC",
      isPeopleFlag: true,
      suggestedAction: "notify-tony",
      evidence: { employeeId: "EMP-44213" },
    }),
    mk({
      id: "payroll-labour-cost-sc",
      agent: "payroll-labour",
      severity: "info",
      title: "Labour cost % MTD",
      body: "Labour-cost-percentage goal input for SC.",
      domain: "labour",
      detector: "goal:labour-cost-pct",
      entityCode: "SC",
      amount: 74.2,
      suggestedAction: "monitor",
      evidence: { source: "payroll-rollup" },
    }),
  ] as FinanceFinding[],

  payables: [
    mk({
      id: "ap-1",
      agent: "payables",
      severity: "warning",
      title: "Possible duplicate invoice on Acme Medical",
      body: "INV-2231 and INV-2232 within 4 days, same amount $1,840.",
      domain: "ap",
      detector: "duplicate-invoice",
      entityCode: "SC",
      amount: 1840,
      suggestedAction: "review",
      evidence: { contactXeroId: "ACME-CONTACT-1", contactName: "Acme Medical" },
    }),
  ] as FinanceFinding[],

  "revenue-claims": [
    mk({
      id: "rev-1",
      agent: "revenue-claims",
      severity: "warning",
      title: "Unclaimed visits (CQ): 12 visits over $1,420",
      body: "Visits delivered but not yet on a claim file.",
      domain: "revenue",
      detector: "unclaimed-visits",
      entityCode: "CQ",
      amount: 1420,
      suggestedAction: "review",
      evidence: { participantId: "PRT-77" },
    }),
    mk({
      id: "rev-goal-unclaimed-sc",
      agent: "revenue-claims",
      severity: "info",
      title: "Unclaimed revenue total — SC",
      body: "Goal input.",
      domain: "revenue",
      detector: "goal:unclaimed-revenue",
      entityCode: "SC",
      amount: 8400,
      suggestedAction: "monitor",
      evidence: {},
    }),
    mk({
      id: "rev-goal-profit-cons",
      agent: "revenue-claims",
      severity: "info",
      title: "Profit run-rate — consolidated",
      body: "Annualised profit run-rate goal input.",
      domain: "profit",
      detector: "goal:profit-run-rate",
      entityCode: "BOTH",
      amount: 2_350_000,
      suggestedAction: "monitor",
      evidence: {},
    }),
  ] as FinanceFinding[],

  receivables: [
    mk({
      id: "ar-1",
      agent: "receivables",
      severity: "warning",
      title: "Aged debtor — Sunrise NDIS Pty Ltd 75 days, $32,400",
      body: "Three statements sent, no response since 2026-04-12.",
      domain: "ar",
      detector: "aged-debtor",
      entityCode: "SC",
      amount: 32400,
      suggestedAction: "review",
      evidence: { contactXeroId: "SUNRISE-CONTACT" },
    }),
    mk({
      id: "ar-goal-dso-sc",
      agent: "receivables",
      severity: "info",
      title: "DSO — SC",
      body: "Days sales outstanding goal input.",
      domain: "ar",
      detector: "goal:dso",
      entityCode: "SC",
      amount: 41,
      suggestedAction: "monitor",
      evidence: {},
    }),
  ] as FinanceFinding[],

  "tax-compliance": [
    mk({
      id: "tax-cash-set-aside-sc",
      agent: "tax-compliance",
      severity: "warning",
      title: "BAS cover required — SC $215,000",
      body: "GST + PAYG estimate for the next BAS.",
      domain: "tax",
      detector: "cash-set-aside",
      entityCode: "SC",
      amount: 215000,
      suggestedAction: "review",
      evidence: {},
    }),
    mk({
      id: "tax-net-gst-cons",
      agent: "tax-compliance",
      severity: "info",
      title: "Net GST owed — consolidated",
      body: "Goal input.",
      domain: "tax",
      detector: "goal:net-gst",
      entityCode: "BOTH",
      amount: 312000,
      suggestedAction: "monitor",
      evidence: {},
    }),
  ] as FinanceFinding[],
};

export function mockFindingsFor(agent: SpecialistAgent): FinanceFinding[] {
  return FIXTURES[agent] ?? [];
}
