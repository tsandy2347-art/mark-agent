// Function B continued — rank correlated issues into today | this-week | note.
//
// Rules (spec section 4):
//   - any critical finding in the group  → today
//   - any people-flag                    → today (and isRestricted=true)
//   - any single amount > $25k           → today
//   - aggregated warnings                → this-week
//   - aggregated info                    → note
//   - a conflict (two specialists disagree about a fact) → today

import type { CorrelationCandidate } from "./correlate";

export type Priority = "today" | "this-week" | "note";

export const TODAY_AMOUNT_THRESHOLD_AUD = 25_000;

export function prioritise(c: CorrelationCandidate): Priority {
  if (c.isConflict) return "today";
  if (c.topSeverity === "critical") return "today";
  if (c.isRestricted) return "today";
  if (c.amount != null && Math.abs(c.amount) > TODAY_AMOUNT_THRESHOLD_AUD) return "today";
  if (c.topSeverity === "warning") return "this-week";
  return "note";
}

export function prioritiseAll(cs: CorrelationCandidate[]): Array<CorrelationCandidate & { priority: Priority }> {
  return cs.map((c) => ({ ...c, priority: prioritise(c) }));
}
