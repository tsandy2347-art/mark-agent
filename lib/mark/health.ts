// SYSTEM CHECK — the first thing in the daily brief.
//
// Answers "did the finance agents actually work this morning?" straight from
// the agents' own run log (audit_runs in the shared findings DB), rather than
// from Mark's SpecialistRunStatus, which is fed by polling the old per-agent
// apps. It runs inside the 07:00 brief, after the agents' 05:00–06:30 runs,
// so it needs nothing on anyone's laptop: if a check fails, the brief says so
// at the top and the subject line is flagged.
//
// Checks:
//   1. each of the seven agents ran since 03:00 today and did not fail;
//   2. no check reported it could not run this morning (*-failed,
//      ingest-failure, *-not-configured findings refreshed today) — listed,
//      not fatal, because a missing feed is a known gap;
//   3. no single check has more than FLOOD_LIMIT open findings — a pile that
//      size has always been a fault (12,203 "no ruleset" lines; 365 coincident
//      "duplicates"), and it also blocks that agent's auto-close.

import { DateTime } from "luxon";
import { latestRunsSince, openFindingCounts, hermesConfigured } from "../hermes-findings";

export const FINANCE_AGENTS = [
  "controls-audit",
  "receivables",
  "revenue-claims",
  "tax-compliance",
  "payroll-labour",
  "reconciliation",
  "payables",
] as const;

export const FLOOD_LIMIT = 300;

export interface SystemCheck {
  ok: boolean;
  /** One line per problem, plain English. Empty when ok. */
  problems: string[];
  /** Known gaps that don't fail the check (feeds not set up, etc.). */
  notes: string[];
  /** e.g. "05:00–06:31" — when this morning's runs happened. */
  window: string | null;
}

function isCannotRun(detector: string): boolean {
  return /(-detector-failed|-failed|^ingest-failure|export-missing|export-unreadable)$/i.test(detector);
}

function isNotConfigured(detector: string): boolean {
  return /-not-configured$/i.test(detector);
}

export async function runSystemCheck(now = new Date()): Promise<SystemCheck> {
  if (!hermesConfigured()) {
    return { ok: false, problems: ["Can't reach the findings database — nothing was checked."], notes: [], window: null };
  }
  const bne = DateTime.fromJSDate(now).setZone("Australia/Brisbane");
  // Since 03:00 Brisbane today — after yesterday's runs, before today's.
  const since = bne.startOf("day").plus({ hours: 3 }).toJSDate();

  const problems: string[] = [];
  const notes: string[] = [];

  const runs = await latestRunsSince(since);
  const times: Date[] = [];
  for (const agent of FINANCE_AGENTS) {
    const r = runs.get(agent);
    if (!r) {
      problems.push(`${agent} did not run this morning.`);
      continue;
    }
    times.push(r.runAt);
    if (r.status === "failed") {
      problems.push(`${agent} crashed this morning${r.failureNote ? `: ${r.failureNote.slice(0, 160)}` : "."}`);
    } else if (r.status === "running") {
      problems.push(`${agent} started but never finished this morning.`);
    }
  }

  const counts = await openFindingCounts(since);
  for (const c of counts) {
    if (!(FINANCE_AGENTS as readonly string[]).includes(c.sourceAgent)) continue;
    if (c.touchedSince > 0 && isCannotRun(c.detector)) {
      problems.push(`${c.sourceAgent}: a check couldn't run — ${c.sampleTitle.slice(0, 140)}`);
    } else if (c.touchedSince > 0 && isNotConfigured(c.detector)) {
      notes.push(`${c.sourceAgent}: ${c.sampleTitle.slice(0, 140)}`);
    }
    if (c.open > FLOOD_LIMIT) {
      problems.push(
        `${c.sourceAgent} "${c.detector}" has ${c.open.toLocaleString("en-AU")} open findings — ` +
          `almost certainly a fault, not that many real problems (and it stops that agent tidying up).`,
      );
    }
  }

  let window: string | null = null;
  if (times.length > 0) {
    const fmt = (d: Date) => DateTime.fromJSDate(d).setZone("Australia/Brisbane").toFormat("HH:mm");
    const sorted = times.map((t) => t.getTime()).sort((a, b) => a - b);
    window = `${fmt(new Date(sorted[0]))}–${fmt(new Date(sorted[sorted.length - 1]))}`;
  }

  return { ok: problems.length === 0, problems, notes, window };
}

/** Plain-text block for the top of the email. */
export function renderSystemCheck(c: SystemCheck): string[] {
  const lines: string[] = [];
  if (c.ok) {
    lines.push(
      `SYSTEM CHECK: ✓ all ${FINANCE_AGENTS.length} finance agents ran this morning` +
        `${c.window ? ` (${c.window})` : ""}, none failed, nothing flooding.`,
    );
  } else {
    lines.push(`SYSTEM CHECK: ✗ ${c.problems.length} problem${c.problems.length === 1 ? "" : "s"} — treat today's figures with care:`);
    for (const p of c.problems) lines.push(`  • ${p}`);
  }
  for (const n of c.notes) lines.push(`  (known gap) ${n}`);
  return lines;
}
