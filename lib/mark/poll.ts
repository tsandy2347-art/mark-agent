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

export interface PollResult {
  agent: SpecialistAgent;
  ok: boolean;
  count: number;
  status: "ok" | "exceptions" | "failed" | "stale" | "never";
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
      await persistStatus(agent, { lastRunStatus: "never", lastError: null, exceptionsOpen: 0 });
      out.push({ agent, ok: false, count: 0, status: "never" });
      continue;
    }

    const stale = isStale(row.lastRunAt);
    // Translate the brain's run.status into Mark's vocabulary.
    let status: PollResult["status"];
    if (stale) {
      status = "stale";
    } else if (row.lastStatus === "ok") {
      status = "ok";
    } else if (row.lastStatus === "exceptions") {
      status = "exceptions";
    } else if (row.lastStatus === "failed") {
      status = "failed";
    } else {
      // Anything else (running, partial, NULL) — treat as exceptions so it
      // still shows in the dashboard with the real open-count.
      status = row.openCount > 0 ? "exceptions" : "ok";
    }

    await persistStatus(agent, {
      lastRunAt: row.lastRunAt,
      lastRunStatus: status,
      lastError: null,
      exceptionsOpen: row.openCount,
    });
    out.push({
      agent,
      ok: status !== "failed",
      count: row.openCount,
      status,
    });
  }
  return out;
}

async function persistStatus(
  agent: SpecialistAgent,
  patch: {
    lastRunAt?: Date;
    lastRunStatus?: "ok" | "exceptions" | "failed" | "stale" | "never";
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
