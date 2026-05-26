// Function C — conflict detection. When two specialists disagree about the
// same underlying fact, Mark surfaces it for human resolution. He does NOT
// silently pick a winner.
//
// Detected heuristically because the spec deliberately scopes conflicts to a
// few known shapes — adding more shapes later is cheap:
//
//   1. Cash position disagreement. Reconciliation publishes a cash figure
//      (detector contains "cash-position"); Tax & Compliance publishes its
//      assumed cash-set-aside figure (detector contains "cash-set-aside" or
//      "gst-cover"). If both exist for the same entityCode and the
//      Reconciliation cash < Tax assumed cash-set-aside, that's a conflict —
//      tax is assuming money that may not be there.
//
//   2. Same correlation group with conflicting amounts. Two specialists post
//      findings about the same supplier/invoice with amounts whose ratio is
//      worse than 2× — they don't agree on the dollar figure.
//
//   3. Same correlation group, one specialist marked resolved=true and
//      another still open. (Means they're not seeing the same picture.)
//
// Conflicts ALWAYS become priority="today" (see prioritise.ts) and ride into
// the daily brief with isConflict=true so they read as "two of your team
// disagree — please look".

import type { IngestedFinding } from "../generated/prisma";
import type { CorrelationCandidate } from "./correlate";

export interface ConflictMarker {
  /** Index into the candidates array. */
  candidateIndex: number;
  reason: string;
}

/** Mark in-place: returns the candidates with isConflict toggled where a
 *  conflict was detected, plus a list of reasons keyed by candidate index. */
export function detectConflicts(
  candidates: CorrelationCandidate[],
  allFindings: IngestedFinding[],
): { candidates: CorrelationCandidate[]; markers: ConflictMarker[] } {
  const markers: ConflictMarker[] = [];

  // ── Per-candidate heuristics (#2, #3). ──
  candidates.forEach((c, idx) => {
    const reasons: string[] = [];
    if (c.sourceAgents.length > 1) {
      const ratioConflict = detectAmountRatioConflict(c);
      if (ratioConflict) reasons.push(ratioConflict);
      const resolutionConflict = detectResolutionConflict(c);
      if (resolutionConflict) reasons.push(resolutionConflict);
    }
    if (reasons.length > 0) {
      c.isConflict = true;
      markers.push({ candidateIndex: idx, reason: reasons.join("; ") });
    }
  });

  // ── Cross-group heuristic (#1) — cash vs cash-set-aside. ──
  // This one CREATES a new candidate if a conflict is found between two
  // findings that didn't share a correlation key.
  const cashConflicts = detectCashVsTaxConflict(allFindings);
  for (const cc of cashConflicts) {
    candidates.push(cc);
    markers.push({ candidateIndex: candidates.length - 1, reason: cc.title });
  }

  return { candidates, markers };
}

function detectAmountRatioConflict(c: CorrelationCandidate): string | null {
  const amounts = c.findings
    .map((f) => (f.amount == null ? null : Number(f.amount)))
    .filter((n): n is number => n != null && Number.isFinite(n) && n !== 0)
    .map((n) => Math.abs(n));
  if (amounts.length < 2) return null;
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  if (max / min < 2) return null;
  return `amounts disagree across specialists: min $${min.toFixed(0)} vs max $${max.toFixed(0)}`;
}

function detectResolutionConflict(c: CorrelationCandidate): string | null {
  // Source findings come from the upstream system at different times; if one
  // specialist already marks the underlying thing resolved while another
  // still has it open, that's a "they're not seeing the same picture" signal.
  const states = new Set(c.findings.map((f) => (f.resolved ? "resolved" : "open")));
  if (states.size < 2) return null;
  return "specialists disagree on whether the underlying issue is resolved";
}

function detectCashVsTaxConflict(findings: IngestedFinding[]): CorrelationCandidate[] {
  const out: CorrelationCandidate[] = [];
  const recon = findings.filter(
    (f) => f.specialistAgent === "reconciliation" && /cash-?position/i.test(f.detector) && !f.resolved,
  );
  const tax = findings.filter(
    (f) =>
      f.specialistAgent === "tax-compliance" &&
      /(cash-?set-?aside|gst-?cover|bas-?cover)/i.test(f.detector) &&
      !f.resolved,
  );
  if (recon.length === 0 || tax.length === 0) return out;

  const byEntity = (rows: IngestedFinding[]): Map<string, IngestedFinding[]> => {
    const m = new Map<string, IngestedFinding[]>();
    for (const r of rows) {
      const arr = m.get(r.entityCode) ?? [];
      arr.push(r);
      m.set(r.entityCode, arr);
    }
    return m;
  };
  const reconByEntity = byEntity(recon);
  const taxByEntity = byEntity(tax);

  for (const [entityCode, reconRows] of reconByEntity.entries()) {
    const taxRows = taxByEntity.get(entityCode);
    if (!taxRows || taxRows.length === 0) continue;
    const cash = mostRecentAmount(reconRows);
    const reserve = mostRecentAmount(taxRows);
    if (cash == null || reserve == null) continue;
    if (cash >= reserve) continue;
    out.push({
      key: `conflict:cash-vs-tax@${entityCode}`,
      title: `Cash vs tax reserve disagreement (${entityCode}): cash $${cash.toFixed(0)}, tax assumes $${reserve.toFixed(0)} set aside`,
      detail:
        `Reconciliation reports cash position $${cash.toFixed(0)} for ${entityCode}.\n` +
        `Tax & Compliance assumes $${reserve.toFixed(0)} is set aside.\n` +
        `Tax may be assuming money that isn't there — please resolve before relying on either figure.`,
      entityCode,
      amount: reserve - cash,
      sourceAgents: ["reconciliation", "tax-compliance"],
      sourceExceptionIds: [
        ...reconRows.map((r) => ({ agent: r.specialistAgent, findingId: r.specialistFindingId })),
        ...taxRows.map((r) => ({ agent: r.specialistAgent, findingId: r.specialistFindingId })),
      ],
      isRestricted: false,
      isConflict: true,
      topSeverity: "critical",
      findings: [...reconRows, ...taxRows],
    });
  }
  return out;
}

function mostRecentAmount(rows: IngestedFinding[]): number | null {
  const sorted = [...rows].sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const r of sorted) {
    if (r.amount == null) continue;
    const n = Number(r.amount);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
