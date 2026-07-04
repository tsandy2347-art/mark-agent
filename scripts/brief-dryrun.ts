// Dry-run of the daily-brief data path — fetch live findings from the shared
// hermes DB, run correlate/prioritise + stale demotion, print the item lists.
// No synthesis, no email, no writes. Run: railway run npx tsx scripts/brief-dryrun.ts
import { correlateFindings } from "../lib/mark/correlate";
import { prioritiseAll } from "../lib/mark/prioritise";
import { applyReceivablesPolicy, fetchOpenFindings } from "../lib/mark/brief";

const STALE_DEMOTE_DAYS = 7;
const STALE_NOTE_DAYS = 21;

async function main() {
  const findings = await fetchOpenFindings();
  console.log(`fetched ${findings.length} open findings (stratified + AR policy detectors)`);
  const byAgent = new Map<string, number>();
  for (const r of findings) byAgent.set(r.specialistAgent, (byAgent.get(r.specialistAgent) ?? 0) + 1);
  console.log("per agent:", Object.fromEntries(byAgent));
  const now = new Date();
  const prioritised = prioritiseAll(correlateFindings(findings)).map((c) => {
    const newestMs = Math.max(...c.findings.map((f) => f.at.getTime()));
    const oldestMs = Math.min(...c.findings.map((f) => f.at.getTime()));
    const lastSeenMs = Math.max(...c.findings.map((f) => {
      const ev = f.evidenceJson;
      const runAt = ev && typeof ev === "object" ? (ev as Record<string, unknown>).runAt : null;
      const t = typeof runAt === "string" ? Date.parse(runAt) : NaN;
      return Number.isFinite(t) ? t : f.at.getTime();
    }));
    const ageDays = Math.floor((now.getTime() - newestMs) / 86_400_000);
    const freshDays = Math.floor((now.getTime() - lastSeenMs) / 86_400_000);
    let priority = c.priority;
    if (ageDays > STALE_NOTE_DAYS) priority = "note" as const;
    else if (ageDays > STALE_DEMOTE_DAYS && priority === "today") priority = "this-week" as const;
    return {
      ...c, priority, ageDays, freshDays,
      firstRaised: new Date(oldestMs).toISOString().slice(0, 10),
      lastSeen: new Date(lastSeenMs).toISOString().slice(0, 10),
    };
  });

  const { candidates: policyApplied, arPolicy } = applyReceivablesPolicy(prioritised, "dry-run");
  console.log("\nAR POLICY SUMMARY:", JSON.stringify(arPolicy.perEntity, null, 1));

  const nonRestricted = policyApplied.filter((c) => !c.isRestricted);
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
