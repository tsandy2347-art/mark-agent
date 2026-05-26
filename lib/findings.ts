// The FinanceFinding wire contract — the shape every specialist emits from its
// /api/findings endpoint. Mark consumes this; he does not produce it. (Mark is
// a sink, not a source. He does not expose /api/findings himself.)
//
// Treat as stable wire format. Adding fields is fine; renaming or removing is
// a breaking change for every specialist.

export type SpecialistAgent =
  | "reconciliation"
  | "controls-audit"
  | "payroll-labour"
  | "payables"
  | "revenue-claims"
  | "receivables"
  | "tax-compliance";

export type Severity = "critical" | "warning" | "info";

export type SuggestedAction =
  | "freeze"
  | "notify-tony"
  | "review"
  | "approve"
  | "monitor"
  // The 5 new specialists may emit additional bounded vocab — Mark accepts
  // any string here and treats unknown values as "review" for prioritisation.
  | string;

export interface FinanceFinding {
  id: string;
  agent: SpecialistAgent;
  at: string;                       // ISO with +10:00
  severity: Severity;
  isPeopleFlag: boolean;
  entityCode: string;               // "SC" | "CQ" | "BOTH"
  domain: string;
  detector: string;
  title: string;
  body: string;
  explanation: string | null;
  evidence: Record<string, unknown>;
  amount: number | null;
  suggestedAction: SuggestedAction;
  resolved: boolean;
}

/** The envelope every specialist's /api/findings returns. */
export interface FindingsEnvelope {
  agent: SpecialistAgent;
  count: number;
  findings: FinanceFinding[];
}
