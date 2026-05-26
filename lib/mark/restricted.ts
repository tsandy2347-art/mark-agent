// Single source of truth for "is this content restricted?" — used by every
// pathway that might place a finding on a brief.
//
// Spec section 2.5 + 6b: people / individual-pay items go to the restricted
// recipient list only. Mark does not widen an audience.
//
// Restricted = TRUE when:
//   - the source finding has isPeopleFlag = true, OR
//   - the source agent is payroll-labour AND the finding carries individual
//     identifiers (employeeId, personId, payslipId, individualName...) in
//     evidence. Aggregate labour figures (total wages, labour cost %) are NOT
//     restricted — only individual rows are.

import type { IngestedFinding } from "../generated/prisma";

const INDIVIDUAL_EVIDENCE_KEYS = [
  "employeeId",
  "employee_id",
  "personId",
  "person_id",
  "payslipId",
  "payslip_id",
  "individualName",
  "individual_name",
  "staffId",
  "staff_id",
  "memberId",
  "member_id",
];

export function isRestrictedFinding(f: Pick<IngestedFinding, "isPeopleFlag" | "specialistAgent" | "evidenceJson">): boolean {
  if (f.isPeopleFlag) return true;
  if (f.specialistAgent === "payroll-labour") {
    const ev = f.evidenceJson;
    if (ev && typeof ev === "object") {
      const obj = ev as Record<string, unknown>;
      if (INDIVIDUAL_EVIDENCE_KEYS.some((k) => obj[k] != null && obj[k] !== "")) return true;
    }
  }
  return false;
}

/** A correlated issue is restricted if ANY of its source findings is. */
export function correlatedIsRestricted(findings: IngestedFinding[]): boolean {
  return findings.some(isRestrictedFinding);
}
