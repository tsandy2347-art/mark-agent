// Specialist health sync — replaces the legacy HTTP poll.
//
// The seven specialists used to be standalone Railway services Mark polled
// every 30 minutes at `${url}/api/findings`. Those services were torn down in
// the consolidation; the live data path is now: detector cron on the brain
// writes `findings` + `audit_runs` to the shared findings DB, and Mark reads
// directly from that DB.
//
// So Mark's idea of "is the fleet alive?" should also come from `audit_runs`.
// This module sweeps audit_runs once and copies the latest run-per-agent into
// `SpecialistRunStatus`, the table the dashboard + briefs already read. No
// HTTP calls anywhere — just a DB-to-DB sync.

import { prisma } from "../prisma";
import { env, type SpecialistAgent, specialists } from "../env";
import { summariseByAgent } from "../hermes-findings";
import { mockFindingsFor } from "./mock/fixtures";

/** Every state a specialist can be in.
 *
 *  The three blind-spot states are the ones that matter, because each one used
 *  to collapse into "ok":
 *    incomplete — the run row never left 'running'. The process started and
 *                 died. Zero findings from a dead process is not a clean bill.
 *    silent     — runs complete, but the agent has never written a finding, or
 *                 hasn't written/refreshed one in SILENT_FINDING_DAYS. It is
 *                 going through the motions and producing nothing.
 *    never      — no run row at all.
 *
 *  `ok` now has to be EARNED: a completed recent run from an agent that is
 *  demonstrably still producing output. Silence is never evidence of health. */
export type SpecialistStatus =
  | "ok"
  | "exceptions"
  | "failed"
  | "stale"
  | "never"
  | "incomplete"
  | "silent";

/** A specialist in one of these states cannot vouch for its domain — Mark must
 *  say so out loud rather than implying the domain is clean. */
export const BLIND_SPOT_STATUSES: ReadonlySet<SpecialistStatus> = new Set<SpecialistStatus>([
  "failed",
  "stale",
  "never",
  "incomplete",
  "silent",
]);

export function isBlindSpot(status: string): boolean {
  return BLIND_SPOT_STATUSES.has(status as SpecialistStatus);
}

/** An agent whose runs complete but which hasn't written or refreshed a single
 *  finding in this many days has gone quiet — treat as a blind spot, not "no
 *  news is good news". */
export const SILENT_FINDING_DAYS = 14;

export interface PollResult {
  agent: SpecialistAgent;
  ok: boolean;
  count: number;
  status: SpecialistStatus;
  error?: string;
}

const KNOWN_AGENTS: SpecialistAgent[] = [
  "reconciliation",
  "controls-audit",
  "payroll-labour",
  "payables",
  "revenue-claims",
  "receivables",
  "tax-compliance",
];

/** Helper used by the daily brief — agents whose lastRunAt is older than
 *  MARK_SPECIALIST_STALE_HOURS, OR have never run, are silent and their
 *  silence is its own finding. */
export function isStale(lastRunAt: Date | null, now: Date = new Date()): boolean {
  if (!lastRunAt) return true;
  const ageMs = now.getTime() - lastRunAt.getTime();
  return ageMs > env.MARK_SPECIALIST_STALE_HOURS * 3600 * 1000;
}

/**
 * Sweep every specialist Mark knows about. For each one, read the latest
 * audit_runs row from the shared findings DB and mirror it into
 * SpecialistRunStatus. No HTTP, no `${url}/api/findings`, no specialist URLs
 * — just the DB the detectors write to.
 *
 * Errors per-agent are absorbed; the function itself never throws.
 */
export async function pollAll(): Promise<PollResult[]> {
  // Mock mode short-circuit — exercise the pipeline without any DB read.
  if (env.MARK_MOCK) {
    const out: PollResult[] = [];
    for (const desc of specialists()) {
      const findings = mockFindingsFor(desc.agent);
      const open = findings.filter((f) => !f.resolved).length;
      const status: PollResult["status"] = open > 0 ? "exceptions" : "ok";
      await persistStatus(desc.agent, {
        lastRunAt: new Date(),
        lastRunStatus: status,
        lastError: null,
        exceptionsOpen: open,
      });
      out.push({ agent: desc.agent, ok: true, count: findings.length, status });
    }
    return out;
  }

  let summary: Awaited<ReturnType<typeof summariseByAgent>>;
  try {
    summary = await summariseByAgent();
  } catch (e) {
    // Findings DB unreachable: mark every agent as failed so the brief surfaces
    // the silence, but don't crash the cron.
    const err = e instanceof Error ? e.message : String(e);
    const out: PollResult[] = [];
    for (const agent of KNOWN_AGENTS) {
      await persistStatus(agent, { lastRunStatus: "failed", lastError: `findings DB read failed: ${err}` });
      out.push({ agent, ok: false, count: 0, status: "failed", error: err });
    }
    return out;
  }

  const byAgent = new Map(summary.map((s) => [s.sourceAgent, s]));
  const out: PollResult[] = [];

  for (const agent of KNOWN_AGENTS) {
    const row = byAgent.get(agent);
    if (!row || !row.lastRunAt) {
      // Detector has never written to audit_runs. Treat as "never" so the
      // briefs flag it as a blind spot.
      await persistStatus(agent, {
        lastRunStatus: "never",
        lastError: "no run has ever been recorded — this domain has never been checked",
        exceptionsOpen: 0,
      });
      out.push({ agent, ok: false, count: 0, status: "never" });
      continue;
    }

    const stale = isStale(row.lastRunAt);
    const findingAgeDays =
      row.lastFindingAt == null
        ? null
        : Math.floor((Date.now() - row.lastFindingAt.getTime()) / 86_400_000);
    // Runs complete but nothing comes out the other end.
    const goneQuiet =
      row.everWroteFindings === 0 || (findingAgeDays != null && findingAgeDays > SILENT_FINDING_DAYS);

    // Translate the brain's run.status into Mark's vocabulary.
    //
    // Order matters: every way of NOT knowing is checked before any way of
    // being fine. The old mapping fell through to `ok` whenever openCount was
    // 0, which is how a payables detector that has never in its life completed
    // a run or written a finding got reported as "no exceptions today ✓".
    let status: SpecialistStatus;
    let blindSpotNote: string | null = null;

    if (stale) {
      status = "stale";
      blindSpotNote = `no run in ${env.MARK_SPECIALIST_STALE_HOURS}h — this domain is unchecked`;
    } else if (row.lastStatus === "failed") {
      status = "failed";
      blindSpotNote = "last run reported failure — this domain is unchecked";
    } else if (row.lastStatus !== "ok" && row.lastStatus !== "exceptions") {
      // 'running', 'partial', NULL, anything unrecognised. The run started and
      // never reached a terminal state, so it produced no trustworthy result.
      status = "incomplete";
      blindSpotNote =
        `last run never completed (status "${row.lastStatus ?? "unknown"}")` +
        (row.lastCompletedRunAt
          ? ` — last completed run ${row.lastCompletedRunAt.toISOString().slice(0, 10)}`
          : " — this detector has never completed a run") +
        ". No result means unchecked, not clean.";
    } else if (goneQuiet) {
      // Terminal status, but the agent isn't producing. Distinguish "never has"
      // from "used to and stopped" — they need different fixes.
      status = "silent";
      blindSpotNote =
        row.everWroteFindings === 0
          ? "runs complete but this detector has never written a single finding — it is not actually checking anything"
          : `runs complete but no finding written or refreshed in ${findingAgeDays} days — its ${row.openCount} open item(s) are unverified carry-over, not today's picture`;
    } else if (row.openCount > 0) {
      status = "exceptions";
    } else {
      status = "ok";
    }

    await persistStatus(agent, {
      lastRunAt: row.lastRunAt,
      lastRunStatus: status,
      lastError: blindSpotNote,
      exceptionsOpen: row.openCount,
    });
    out.push({
      agent,
      ok: !isBlindSpot(status),
      count: row.openCount,
      status,
      ...(blindSpotNote ? { error: blindSpotNote } : {}),
    });
  }
  return out;
}

async function persistStatus(
  agent: SpecialistAgent,
  patch: {
    lastRunAt?: Date;
    lastRunStatus?: SpecialistStatus;
    lastError?: string | null;
    exceptionsOpen?: number;
  },
): Promise<void> {
  await prisma.specialistRunStatus.upsert({
    where: { agent },
    create: {
      agent,
      lastRunAt: patch.lastRunAt ?? null,
      lastRunStatus: patch.lastRunStatus ?? "never",
      lastError: patch.lastError ?? null,
      exceptionsOpen: patch.exceptionsOpen ?? 0,
    },
    update: {
      ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
      ...(patch.lastRunStatus !== undefined ? { lastRunStatus: patch.lastRunStatus } : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      ...(patch.exceptionsOpen !== undefined ? { exceptionsOpen: patch.exceptionsOpen } : {}),
    },
  });
}
