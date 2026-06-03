// Centralised env access. Mark consumes every config knob through here.
//
// Mark is an orchestrator: he reads 7 specialists, synthesises, escalates.
// He never holds source-system creds (no Xero, no MYOB, no bank, no ATO).
// He holds specialist URLs + the shared HUB_API_KEY he uses to read them.

import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),

  // ── Auth (human-facing pages) ────────────────────────────────────
  // Single-user: BASIC_AUTH_USER + BASIC_AUTH_PASS
  // Multi-user:  BASIC_AUTH_USERS=tony:pwA,lindsay:pwB,nicole:pwC
  BASIC_AUTH_USER: z.string().optional().default(""),
  BASIC_AUTH_PASS: z.string().optional().default(""),
  BASIC_AUTH_USERS: z.string().optional().default(""),

  /** General admin users — they see /goals, /qa, /specialists in full. */
  ADMIN_USERNAMES: z.string().default("tony"),

  /** Restricted users — they alone see /restricted (people + individual pay).
   *  Default per spec section 2.5 + report routing: Tony + Lindsay (people) +
   *  Nicole (pay). Mark gates the route by Basic-auth username. */
  MARK_RESTRICTED_USERNAMES: z.string().default("tony,lindsay,nicole"),

  // ── Specialist endpoints (one base URL per agent) ────────────────
  // Mark calls ${URL}/api/findings with Authorization: Bearer ${HUB_API_KEY}.
  // Leave a URL blank to disable polling for that specialist (marks it stale).
  SPECIALIST_RECONCILIATION_URL: z.string().optional().default(""),
  SPECIALIST_CONTROLS_AUDIT_URL: z.string().optional().default(""),
  SPECIALIST_PAYROLL_LABOUR_URL: z.string().optional().default(""),
  SPECIALIST_PAYABLES_URL: z.string().optional().default(""),
  SPECIALIST_REVENUE_CLAIMS_URL: z.string().optional().default(""),
  SPECIALIST_RECEIVABLES_URL: z.string().optional().default(""),
  SPECIALIST_TAX_COMPLIANCE_URL: z.string().optional().default(""),

  /** Shared Bearer key Mark presents to every specialist's /api/findings.
   *  In production the same value lives on Mark + all 7 specialists. */
  HUB_API_KEY: z.string().optional().default(""),

  // Per-specialist CRON_SECRET — Mark presents this when the user asks for
  // an on-demand re-run via the trigger_specialist_run tool. NOT the same
  // as HUB_API_KEY: each specialist's /api/cron/run uses its own secret.
  // Leave blank to disable on-demand triggering for that specialist (the
  // tool returns a clear "not wired" error).
  SPECIALIST_RECONCILIATION_CRON_SECRET: z.string().optional().default(""),
  SPECIALIST_CONTROLS_AUDIT_CRON_SECRET: z.string().optional().default(""),
  SPECIALIST_PAYROLL_LABOUR_CRON_SECRET: z.string().optional().default(""),
  SPECIALIST_PAYABLES_CRON_SECRET: z.string().optional().default(""),
  SPECIALIST_REVENUE_CLAIMS_CRON_SECRET: z.string().optional().default(""),
  SPECIALIST_RECEIVABLES_CRON_SECRET: z.string().optional().default(""),
  SPECIALIST_TAX_COMPLIANCE_CRON_SECRET: z.string().optional().default(""),

  /** Public-proxy URL for the hermes-jbc Postgres `findings` + `audit_runs`
   *  tables. Read-only. Powers /hermes-activity. Leave blank to hide the page. */
  HERMES_FINDINGS_DATABASE_URL: z.string().optional().default(""),

  // ── LLM backend routing ─────────────────────────────────────────
  /** Which LLM endpoint Mark's /qa calls. "anthropic" (default) hits the
   *  Anthropic SDK directly — fast, proven, no learning loop. "hermes" hits
   *  hermes-jbc /v1/chat/completions — slower (loads skill registry every
   *  turn, ~16K prompt-tokens of overhead), but feeds Hermes's autonomous
   *  skill_manage loop so Mark gradually authors new skills from experience. */
  MARK_LLM_BACKEND: z
    .enum(["anthropic", "hermes"]) // strict — typo = fail-fast
    .optional()
    .default("anthropic"),
  /** hermes-jbc base URL (https://hermes-jbc-production.up.railway.app).
   *  Required when MARK_LLM_BACKEND=hermes. */
  HERMES_BASE_URL: z.string().optional().default(""),
  /** Bearer key for hermes-jbc /v1/* — matches API_SERVER_KEY on hermes-jbc. */
  HERMES_API_SERVER_KEY: z.string().optional().default(""),

  /** payroll-poster service — the deterministic Xero DRAFT poster. Mark POSTs
   *  the stored 3-file set here; the poster runs the verified parser with
   *  --post-draft (DRAFT-locked) and returns the Xero links. Mark holds NO
   *  Xero keys; the poster does. */
  PAYROLL_POSTER_URL: z.string().optional().default(""),
  PAYROLL_POSTER_API_KEY: z.string().optional().default(""),

  // ── Anthropic ────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),

  // ── Cadence (Brisbane local) — spec section 7 ────────────────────
  /** HH:mm the daily brief is sent. Default 07:00. The cron sidecar fires
   *  POST /api/cron/brief at the matching UTC time. */
  MARK_DAILY_BRIEF_TIME: z.string().default("07:00"),
  /** Day-of-week (1=Mon..7=Sun) the weekly report is sent. Default Monday. */
  MARK_WEEKLY_REPORT_DAY: z.coerce.number().int().min(1).max(7).default(1),
  /** Day-of-month the monthly pack is sent. Default 3rd (gives close some air). */
  MARK_MONTHLY_PACK_DAY: z.coerce.number().int().min(1).max(28).default(3),
  /** A specialist not run successfully inside this window is "stale" — that
   *  staleness becomes its own brief item. */
  MARK_SPECIALIST_STALE_HOURS: z.coerce.number().int().default(36),

  // ── Report routing — spec section 6 ──────────────────────────────
  /** Daily finance brief — Tony + Nicole. NEVER receives people / pay data. */
  MARK_DAILY_RECIPIENTS: z.string().default(""),
  /** Restricted brief — Tony + Lindsay (people) and/or Nicole (pay). Only
   *  fires when there's something restricted. */
  MARK_RESTRICTED_RECIPIENTS: z.string().default(""),
  /** Weekly team report — Tony + section-owning managers. Aggregate figures
   *  only, no individual data. */
  MARK_WEEKLY_RECIPIENTS: z.string().default(""),
  /** Monthly pack — Tony + external accountant. */
  MARK_MONTHLY_RECIPIENTS: z.string().default(""),
  /** Heartbeat failure — Tony only. Silent watchdog = broken watchdog. */
  MARK_HEARTBEAT_RECIPIENTS: z.string().default(""),

  // ── Goal targets — spec section 7 ────────────────────────────────
  /** The headline. Tony's $3M profit target. */
  GOAL_PROFIT_TARGET_AUD: z.coerce.number().default(3_000_000),
  /** Per-entity labour cost % targets — CONFIRM with Tony. */
  GOAL_LABOUR_COST_TARGET_PCT_SC: z.coerce.number().default(72),
  GOAL_LABOUR_COST_TARGET_PCT_CQ: z.coerce.number().default(72),
  /** DSO (days sales outstanding) target. */
  GOAL_DSO_TARGET_DAYS: z.coerce.number().default(35),

  // ── Q&A channel — spec section 4 (Function E) CONFIRM ────────────
  /** "dashboard-chat" (default — uses the /qa page) or "helpdesk" (future). */
  MARK_QA_CHANNEL: z.string().default("dashboard-chat"),

  // ── Email plumbing ───────────────────────────────────────────────
  REPORT_FROM: z.string().default("mark@justbettercareqld.com.au"),
  AWS_REGION: z.string().default("ap-southeast-2"),
  AWS_ACCESS_KEY_ID: z.string().optional().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),

  // ── Cron auth ────────────────────────────────────────────────────
  CRON_SECRET: z.string().optional().default(""),

  // ── Voice (Vapi) auth ────────────────────────────────────────────
  /** Shared secret between Vapi and Mark's /api/voice/chat/completions
   *  endpoint. Vapi presents it as `Authorization: Bearer <key>` on the
   *  Custom-LLM call. Same role as Adam's LLM_API_KEY. When empty the voice
   *  endpoint is disabled (returns 503) so a misconfigured deploy can't leak
   *  an open finance brain. */
  VOICE_API_KEY: z.string().optional().default(""),

  // ── Honcho memory layer (self-host, shared with Adam) ───────────
  /** Honcho base URL — same instance every JBC agent points at. */
  HONCHO_BASE_URL: z.string().optional().default(""),
  /** Honcho JWT — admin-scoped, lets Mark read peer.context + write messages. */
  HONCHO_JWT: z.string().optional().default(""),
  /** Honcho workspace. Default matches the Jarvis-wide workspace. */
  HONCHO_WORKSPACE: z.string().default("jbc-jarvis"),
  /** Mark's peer name inside the workspace. Adam = "adam". */
  HONCHO_MARK_PEER: z.string().default("mark"),
  /** Network timeout for Honcho calls — never block Mark on a memory layer
   *  hiccup. Adam's pattern; same here. */
  HONCHO_TIMEOUT_MS: z.coerce.number().int().default(4000),

  // ── CSV import endpoint (read by Hermes skills, not by Mark itself) ─
  /** Public base URL the read-only Hermes skills hit to fetch the latest
   *  uploaded CSV (e.g. https://mark-agent-production.up.railway.app). Read
   *  here so the value is documented + visible alongside the rest of Mark's
   *  config; the skills themselves consume the same env var name. */
  MARK_IMPORT_BASE_URL: z.string().optional().default(""),
  /** Basic-auth header value the skills present to GET /api/imports/*.
   *  Format: "Basic base64(user:pass)". Same caveat — documented here, set
   *  on the skill side. */
  MARK_IMPORT_AUTH: z.string().optional().default(""),

  // ── Mock mode ────────────────────────────────────────────────────
  /** When on, Mark never calls a specialist — he uses canned fixtures so
   *  the whole brief pipeline is exercisable without the team being up. */
  MARK_MOCK: z
    .string()
    .optional()
    .default("")
    .transform((s) => s.toLowerCase() === "true" || s === "1"),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const env = schema.parse(process.env);

export function recipients(list: string): string[] {
  return list.split(",").map((s) => s.trim()).filter(Boolean);
}

export function adminUsernames(): string[] {
  return env.ADMIN_USERNAMES.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function restrictedUsernames(): string[] {
  return env.MARK_RESTRICTED_USERNAMES.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Canonical list of Mark's 7 specialists + their base URLs.
 *  A URL that's blank means "not yet wired" — `pollSpecialist` records that as
 *  status="failed" with lastError="no SPECIALIST_*_URL configured" so it
 *  surfaces in the brief, the way a broken pipe should. */
export interface SpecialistDescriptor {
  agent: SpecialistAgent;
  label: string;
  url: string;
}

export type SpecialistAgent =
  | "reconciliation"
  | "controls-audit"
  | "payroll-labour"
  | "payables"
  | "revenue-claims"
  | "receivables"
  | "tax-compliance";

export const SPECIALIST_AGENTS: SpecialistAgent[] = [
  "reconciliation",
  "controls-audit",
  "payroll-labour",
  "payables",
  "revenue-claims",
  "receivables",
  "tax-compliance",
];

export function specialists(): SpecialistDescriptor[] {
  return [
    { agent: "reconciliation",  label: "Reconciliation",   url: env.SPECIALIST_RECONCILIATION_URL },
    { agent: "controls-audit",  label: "Controls & Audit", url: env.SPECIALIST_CONTROLS_AUDIT_URL },
    { agent: "payroll-labour",  label: "Payroll & Labour", url: env.SPECIALIST_PAYROLL_LABOUR_URL },
    { agent: "payables",        label: "Payables",         url: env.SPECIALIST_PAYABLES_URL },
    { agent: "revenue-claims",  label: "Revenue & Claims", url: env.SPECIALIST_REVENUE_CLAIMS_URL },
    { agent: "receivables",     label: "Receivables",      url: env.SPECIALIST_RECEIVABLES_URL },
    { agent: "tax-compliance",  label: "Tax & Compliance", url: env.SPECIALIST_TAX_COMPLIANCE_URL },
  ];
}
