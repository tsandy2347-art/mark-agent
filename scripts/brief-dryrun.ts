// Dry-run of the daily-brief data path — fetch live findings from the shared
// hermes DB, run correlate/prioritise + stale demotion, print the item lists.
// No synthesis, no email, no writes. Run: railway run npx tsx scripts/brief-dryrun.ts
import { listOpenFindingsForQa, type HermesFinding } from "../lib/hermes-findings";
import { correlateFindings } from "../lib/mark/correlate";
import { prioritiseAll } from "../lib/mark/prioritise";
import type { IngestedFinding } from "../lib/generated/prisma";

const STALE_DEMOTE_DAYS = 7;
const STALE_NOTE_DAYS = 21;

function hermesToFinding(f: HermesFinding): IngestedFinding {
  return {
    id: f.id,
    specialistAgent: f.sourceAgent,
    specialistFindingId: f.id,
    at: f.createdAt,
    severity: f.severity,
    isPeopleFlag: f.isPeopleFlag,
    entityCode: f.entityCode,
    domain: f.domain,
    detector: f.detector,
    title: f.title,
    body: f.detail,
    explanation: f.aiExplanation,
    evidenceJson: (f.evidence ?? {}) as IngestedFinding["evidenceJson"],
    amount: f.amount as unknown as IngestedFinding["amount"],
    suggestedAction: "",
    resolved: f.resolved,
    ingestedAt: f.createdAt,
    updatedAt: f.createdAt,
  } as IngestedFinding;
}

async function main() {
  const rows = await listOpenFindingsForQa({ includePeopleFlag: true, limit: 800, perAgentCap: 120 });
  console.log(`fetched ${rows.length} open findings from shared DB`);
  const byAgent = new Map<string, number>();
  for (const r of rows) byAgent.set(r.sourceAgent, (byAgent.get(r.sourceAgent) ?? 0) + 1);
  console.log("per agent:", Object.fromEntries(byAgent));

  const findings = rows.map(hermesToFinding);
  const now = new Date();
  const prioritised = prioritiseAll(correlateFindings(findings)).map((c) => {
    const newestMs = Math.max(...c.findings.map((f) => f.at.getTime()));
    const oldestMs = Math.min(...c.findings.map((f) => f.at.getTime()));
    const ageDays = Math.floor((now.getTime() - newestMs) / 86_400_000);
    let priority = c.priority;
    if (ageDays > STALE_NOTE_DAYS) priority = "note" as const;
    else if (ageDays > STALE_DEMOTE_DAYS && priority === "today") priority = "this-week" as const;
    return { ...c, priority, ageDays, firstRaised: new Date(oldestMs).toISOString().slice(0, 10) };
  });

  const nonRestricted = prioritised.filter((c) => !c.isRestricted);
  const views = {
    "TONY daily (receivables-only items excluded)": nonRestricted.filter(
      (c) => !c.sourceAgents.every((a) => a === "receivables"),
    ),
    "NICOLE recon-ar (reconciliation + receivables only)": nonRestricted.filter(
      (c) => c.sourceAgents.some((a) => a === "reconciliation" || a === "receivables"),
    ),
  };
  for (const [name, view] of Object.entries(views)) {
    console.log(`\n########## ${name} ##########`);
    for (const bucket of ["today", "this-week", "note"] as const) {
      const items = view.filter((c) => c.priority === bucket);
      console.log(`=== ${bucket.toUpperCase()} (${items.length}) ===`);
      for (const it of items.slice(0, 12)) {
        console.log(`  [${it.entityCode}] ${it.title} — age ${it.ageDays}d [${it.sourceAgents.join(",")}]`);
      }
      if (items.length > 12) console.log(`  ... ${items.length - 12} more`);
    }
  }
  console.log(`\nrestricted items: ${prioritised.filter((c) => c.isRestricted).length}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
