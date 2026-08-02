// Dry-run of the COVERAGE path only — what Mark can and cannot vouch for.
// Reads the shared hermes DB, replays the poll.ts status decision for every
// specialist, and rolls up detector failures. No writes, no email.
//
//   railway run npx tsx scripts/coverage-dryrun.ts
import { summariseByAgent } from "../lib/hermes-findings";
import { SILENT_FINDING_DAYS } from "../lib/mark/poll";
import { fetchOpenFindings, summariseDetectorFailures } from "../lib/mark/brief";

const STALE_HOURS = Number(process.env.MARK_SPECIALIST_STALE_HOURS ?? 36);

async function main() {
  const summary = await summariseByAgent();
  console.log("=== SPECIALIST COVERAGE ===");
  for (const row of summary) {
    const stale =
      !row.lastRunAt || Date.now() - row.lastRunAt.getTime() > STALE_HOURS * 3600 * 1000;
    const findingAgeDays =
      row.lastFindingAt == null
        ? null
        : Math.floor((Date.now() - row.lastFindingAt.getTime()) / 86_400_000);
    const goneQuiet =
      row.everWroteFindings === 0 || (findingAgeDays != null && findingAgeDays > SILENT_FINDING_DAYS);

    let status: string;
    if (stale) status = "stale";
    else if (row.lastStatus === "failed") status = "failed";
    else if (row.lastStatus !== "ok" && row.lastStatus !== "exceptions") status = "incomplete";
    else if (goneQuiet) status = "silent";
    else if (row.openCount > 0) status = "exceptions";
    else status = "ok";

    const blind = !["ok", "exceptions"].includes(status);
    console.log(
      `${blind ? "✗" : "✓"} ${row.sourceAgent.padEnd(28)} ${status.padEnd(11)}` +
        ` runStatus=${String(row.lastStatus).padEnd(11)}` +
        ` open=${String(row.openCount).padEnd(5)}` +
        ` lastFinding=${findingAgeDays == null ? "never" : `${findingAgeDays}d ago`}` +
        ` everWrote=${row.everWroteFindings}`,
    );
  }

  const gaps = summariseDetectorFailures(await fetchOpenFindings(), new Date());
  console.log(`\n=== DETECTOR BLIND SPOTS (${gaps.length}) ===`);
  for (const g of gaps) {
    console.log(
      `✗ ${g.agent} / ${g.detector} [${g.entities.join(",")}] — ${g.daysFailing} run(s)` +
        ` since ${g.firstSeen}${g.chronic ? " — CHRONIC" : ""}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
