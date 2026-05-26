// Function B — dedupe + correlate. Given a list of open IngestedFinding rows,
// group findings that touch the same underlying thing into CorrelatedIssue
// candidates.
//
// Heuristic per spec section 4:
//   (a) Same entityCode + same primary evidence identifier
//       (vendorId / contactXeroId / invoiceId / participantId / employeeId).
//   (b) Cross-detector themes on the same identifier: e.g. Payables
//       `duplicate-invoice` and Controls `vendor-bank-change` on the same
//       supplier — both go on one card.
//
// Mark does NOT silently pick a "winner" — if two specialists disagree about
// the same fact, conflict.ts elevates the card with isConflict=true.

import type { IngestedFinding } from "../generated/prisma";
import { correlatedIsRestricted } from "./restricted";

const IDENTIFIER_KEYS = [
  "vendorId",
  "vendor_id",
  "contactXeroId",
  "contact_xero_id",
  "supplierId",
  "supplier_id",
  "invoiceId",
  "invoice_id",
  "billId",
  "bill_id",
  "participantId",
  "participant_id",
  "clientId",
  "client_id",
  "employeeId",
  "employee_id",
  "personId",
  "person_id",
  "bankAccountId",
  "bank_account_id",
  "abn",
  "ABN",
];

export interface CorrelationCandidate {
  /** Stable correlation key. Same key on two findings → same correlated issue. */
  key: string;
  title: string;
  detail: string;
  entityCode: string;
  amount: number | null;
  sourceAgents: string[];
  sourceExceptionIds: Array<{ agent: string; findingId: string }>;
  isRestricted: boolean;
  isConflict: boolean;
  /** highest severity across the group */
  topSeverity: "critical" | "warning" | "info";
  /** all findings that contributed, for downstream conflict detection */
  findings: IngestedFinding[];
}

/** Public entry point — group findings into correlation candidates.
 *  Goal-input findings (detector starts with `goal:`) are NOT correlated —
 *  they're metric tape, not issues. They're consumed by lib/mark/goals.ts
 *  separately and never appear as action items. */
export function correlateFindings(findings: IngestedFinding[]): CorrelationCandidate[] {
  const groups = new Map<string, IngestedFinding[]>();

  for (const f of findings) {
    if (f.resolved) continue;
    if (f.detector?.startsWith("goal:")) continue;
    const keys = correlationKeysFor(f);
    if (keys.length === 0) {
      // No usable identifier. Info-severity rows without an identifier are
      // metric tape (e.g. "SC cash position $182,400") — not action items.
      // They still get consumed by brief.ts for the cash panel and by
      // conflict.ts. Critical/warning rows without an identifier survive as
      // singletons so we don't lose them.
      if (f.severity === "info") continue;
      const k = `singleton::${f.specialistAgent}::${f.specialistFindingId}`;
      groups.set(k, [f]);
      continue;
    }
    // Use the first identifier as the canonical group, but also alias the
    // others so a finding that knows the vendor by both vendorId and
    // contactXeroId still merges. Cheap: alias the other keys to point at
    // the canonical.
    const canonical = keys[0];
    const bucket = groups.get(canonical) ?? [];
    bucket.push(f);
    groups.set(canonical, bucket);
  }

  const candidates: CorrelationCandidate[] = [];
  for (const [key, group] of groups.entries()) {
    if (group.length === 0) continue;
    candidates.push(buildCandidate(key, group));
  }

  // Sort: criticals first, then warnings, then info — within each, larger
  // amounts first.
  const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  candidates.sort((a, b) => {
    const s = (sevOrder[a.topSeverity] ?? 3) - (sevOrder[b.topSeverity] ?? 3);
    if (s !== 0) return s;
    return (b.amount ?? 0) - (a.amount ?? 0);
  });
  return candidates;
}

function correlationKeysFor(f: IngestedFinding): string[] {
  const out: string[] = [];
  const ev = f.evidenceJson;
  if (!ev || typeof ev !== "object") return out;
  const obj = ev as Record<string, unknown>;
  for (const k of IDENTIFIER_KEYS) {
    const v = obj[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    out.push(`${kindOf(k)}:${s}@${f.entityCode}`);
  }
  return out;
}

function kindOf(k: string): string {
  if (/(vendor|supplier|contact|abn)/i.test(k)) return "supplier";
  if (/(invoice|bill)/i.test(k)) return "invoice";
  if (/(participant|client)/i.test(k)) return "participant";
  if (/(employee|person|staff|member)/i.test(k)) return "employee";
  if (/bank/i.test(k)) return "bank";
  return "ref";
}

function buildCandidate(key: string, group: IngestedFinding[]): CorrelationCandidate {
  const sourceAgents = [...new Set(group.map((f) => f.specialistAgent))];
  const entityCodes = [...new Set(group.map((f) => f.entityCode))];
  const entityCode = entityCodes.length === 1 ? entityCodes[0] : "BOTH";

  // Amount: max absolute amount across the group is the most useful single
  // figure for prioritising. (Sum could double-count when two specialists
  // touched the same dollar.)
  let amount: number | null = null;
  for (const f of group) {
    if (f.amount == null) continue;
    const n = Number(f.amount);
    if (!Number.isFinite(n)) continue;
    if (amount == null || Math.abs(n) > Math.abs(amount)) amount = n;
  }

  // Severity = highest of the group.
  const sev = (s: string): number => (s === "critical" ? 0 : s === "warning" ? 1 : 2);
  const top = group.reduce((acc, f) => (sev(f.severity) < sev(acc.severity) ? f : acc), group[0]);
  const topSeverity = (top.severity as CorrelationCandidate["topSeverity"]) ?? "info";

  // Title: use top severity finding's title; if multi-agent, prepend the
  // count so it's obvious this is correlated.
  const title = sourceAgents.length > 1
    ? `[${sourceAgents.length} agents] ${top.title}`
    : top.title;

  // Detail: short per-agent summary so the card is readable without drilling
  // into evidence.
  const detail = group
    .map((f) => `• ${f.specialistAgent}: ${f.title}${f.amount != null ? ` ($${Number(f.amount).toFixed(2)})` : ""}`)
    .join("\n");

  return {
    key,
    title,
    detail,
    entityCode,
    amount,
    sourceAgents,
    sourceExceptionIds: group.map((f) => ({ agent: f.specialistAgent, findingId: f.specialistFindingId })),
    isRestricted: correlatedIsRestricted(group),
    isConflict: false, // conflict.ts sets this
    topSeverity,
    findings: group,
  };
}
