// Read-only client for the hermes-jbc Postgres — the shared `findings` +
// `audit_runs` tables every Hermes finance skill writes to.
//
// Lazy-initialised pg pool. If HERMES_FINDINGS_DATABASE_URL is blank we
// don't even open the pool; callers branch on `hermesConfigured()`.

import { Pool } from "pg";
import { env } from "./env";

let _pool: Pool | null = null;

export function hermesConfigured(): boolean {
  return Boolean(env.HERMES_FINDINGS_DATABASE_URL);
}

function pool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: env.HERMES_FINDINGS_DATABASE_URL,
      // Conservative — this is a side-quest, never the hot path.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return _pool;
}

export interface HermesAuditRun {
  id: string;
  sourceAgent: string;
  runAt: Date;
  status: string;
  exceptionsCount: number;
  criticalCount: number;
  peopleFlagsCount: number;
  durationMs: number | null;
  failureNote: string | null;
}

export interface HermesFinding {
  id: string;
  sourceAgent: string;
  runId: string | null;
  detector: string;
  domain: string;
  severity: string;
  entityCode: string;
  isPeopleFlag: boolean;
  title: string;
  detail: string;
  amount: number | null;
  aiExplanation: string | null;
  resolved: boolean;
  createdAt: Date;
  /** jsonb — Xero deep-links, source ids, narrations, dedupKey, etc.
   *  Mark passes the whole thing through to Claude untouched so the
   *  agent can quote keys verbatim if asked. */
  evidence: unknown;
}

export async function listRecentAuditRuns(limit = 30): Promise<HermesAuditRun[]> {
  if (!hermesConfigured()) return [];
  const { rows } = await pool().query(
    `SELECT id, source_agent, run_at, status, exceptions_count, critical_count,
            people_flags_count, duration_ms, failure_note
       FROM audit_runs
       ORDER BY run_at DESC
       LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    sourceAgent: r.source_agent,
    runAt: r.run_at,
    status: r.status,
    exceptionsCount: r.exceptions_count ?? 0,
    criticalCount: r.critical_count ?? 0,
    peopleFlagsCount: r.people_flags_count ?? 0,
    durationMs: r.duration_ms,
    failureNote: r.failure_note,
  }));
}

export async function listRecentFindings(limit = 30): Promise<HermesFinding[]> {
  if (!hermesConfigured()) return [];
  const { rows } = await pool().query(
    `SELECT id, source_agent, run_id, detector, domain, severity, entity_code,
            is_people_flag, title, detail, amount, ai_explanation, resolved,
            created_at, evidence
       FROM findings
       ORDER BY created_at DESC
       LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    sourceAgent: r.source_agent,
    runId: r.run_id,
    detector: r.detector,
    domain: r.domain,
    severity: r.severity,
    entityCode: r.entity_code,
    isPeopleFlag: r.is_people_flag,
    title: r.title,
    detail: r.detail,
    amount: r.amount !== null ? Number(r.amount) : null,
    aiExplanation: r.ai_explanation,
    resolved: r.resolved,
    createdAt: r.created_at,
    evidence: r.evidence ?? null,
  }));
}

/** Open findings for Mark's /qa context. Pulls from the shared
 *  hermes-jbc findings DB (the table every Hermes skill writes to)
 *  instead of Mark's local IngestedFinding mirror, so Mark sees the
 *  latest skill output without a poll cycle in between.
 *
 *  Filters: resolved=false, optional people-flag include/exclude.
 *
 *  Fairness: stratified per source_agent so one noisy specialist (e.g.
 *  receivables with hundreds of overdue invoices) can't starve the other
 *  six out of Mark's context window. Each source_agent contributes at
 *  most `perAgentCap` findings, severity-ordered (critical > warning >
 *  info). After the per-agent cut, the union is clipped to `limit`.
 */
export async function listOpenFindingsForQa(args: {
  includePeopleFlag: boolean;
  limit?: number;
  perAgentCap?: number;
}): Promise<HermesFinding[]> {
  if (!hermesConfigured()) return [];
  const limit = args.limit ?? 400;
  const perAgentCap = args.perAgentCap ?? 80;
  const whereParts: string[] = ["resolved=false"];
  if (!args.includePeopleFlag) whereParts.push("is_people_flag=false");
  const where = whereParts.join(" AND ");
  // ROW_NUMBER() per source_agent keeps each specialist's top-N regardless
  // of total volume. Final sort is global severity-then-recency.
  const { rows } = await pool().query(
    `WITH ranked AS (
       SELECT id, source_agent, run_id, detector, domain, severity, entity_code,
              is_people_flag, title, detail, amount, ai_explanation, resolved,
              created_at, evidence,
              ROW_NUMBER() OVER (
                PARTITION BY source_agent
                ORDER BY
                  CASE severity
                    WHEN 'critical' THEN 0
                    WHEN 'warning'  THEN 1
                    WHEN 'info'     THEN 2
                    ELSE 3
                  END,
                  created_at DESC
              ) AS rn
         FROM findings
         WHERE ${where}
     )
     SELECT * FROM ranked
      WHERE rn <= $1
      ORDER BY CASE severity
                 WHEN 'critical' THEN 0
                 WHEN 'warning'  THEN 1
                 WHEN 'info'     THEN 2
                 ELSE 3
               END,
               created_at DESC
      LIMIT $2`,
    [perAgentCap, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    sourceAgent: r.source_agent,
    runId: r.run_id,
    detector: r.detector,
    domain: r.domain,
    severity: r.severity,
    entityCode: r.entity_code,
    isPeopleFlag: r.is_people_flag,
    title: r.title,
    detail: r.detail,
    amount: r.amount !== null ? Number(r.amount) : null,
    aiExplanation: r.ai_explanation,
    resolved: r.resolved,
    createdAt: r.created_at,
    evidence: r.evidence ?? null,
  }));
}

export interface HermesAgentSummary {
  sourceAgent: string;
  lastRunAt: Date | null;
  lastStatus: string | null;
  openCount: number;
  openCritical: number;
  totalRuns: number;
}

export interface HermesSkillInventoryRow {
  path: string;
  name: string;
  parent: string | null;
  description: string | null;
  mtime: Date;
  scannedAt: Date;
  deleted: boolean;
}

export async function listSkillInventory(limit = 100): Promise<HermesSkillInventoryRow[]> {
  if (!hermesConfigured()) return [];
  // Tolerate "table doesn't exist yet" — first scan hasn't fired.
  try {
    const { rows } = await pool().query(
      `SELECT path, name, parent, description, mtime, scanned_at, deleted
         FROM skills_inventory
         WHERE deleted = false
         ORDER BY mtime DESC
         LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      path: r.path,
      name: r.name,
      parent: r.parent,
      description: r.description,
      mtime: r.mtime,
      scannedAt: r.scanned_at,
      deleted: r.deleted,
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist/i.test(msg)) return [];
    throw e;
  }
}

export async function summariseByAgent(): Promise<HermesAgentSummary[]> {
  if (!hermesConfigured()) return [];
  // Two roll-ups in one round-trip via a CTE — total_runs + last_run from
  // audit_runs, open_count from findings.
  const { rows } = await pool().query(
    `WITH last_run AS (
       SELECT DISTINCT ON (source_agent)
              source_agent, run_at AS last_run_at, status AS last_status
         FROM audit_runs
         ORDER BY source_agent, run_at DESC
     ),
     run_totals AS (
       SELECT source_agent, COUNT(*)::int AS total_runs
         FROM audit_runs
         GROUP BY source_agent
     ),
     open_totals AS (
       SELECT source_agent,
              COUNT(*)::int AS open_count,
              COUNT(*) FILTER (WHERE severity = 'critical')::int AS open_critical
         FROM findings
         WHERE resolved = false
         GROUP BY source_agent
     )
     SELECT COALESCE(lr.source_agent, ot.source_agent, rt.source_agent) AS source_agent,
            lr.last_run_at,
            lr.last_status,
            COALESCE(ot.open_count, 0) AS open_count,
            COALESCE(ot.open_critical, 0) AS open_critical,
            COALESCE(rt.total_runs, 0) AS total_runs
       FROM last_run lr
       FULL OUTER JOIN open_totals ot ON ot.source_agent = lr.source_agent
       FULL OUTER JOIN run_totals  rt ON rt.source_agent = lr.source_agent
      ORDER BY 1`,
  );
  return rows.map((r) => ({
    sourceAgent: r.source_agent,
    lastRunAt: r.last_run_at ?? null,
    lastStatus: r.last_status ?? null,
    openCount: r.open_count ?? 0,
    openCritical: r.open_critical ?? 0,
    totalRuns: r.total_runs ?? 0,
  }));
}
