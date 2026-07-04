// Render any brief exactly as it would email, without sending or persisting.
// Run: railway run env DATABASE_URL=<public-url> npx tsx scripts/preview-brief.ts [daily|recon-ar|weekly|monthly]
import { buildBrief, type BriefType } from "../lib/mark/brief";

const type = (process.argv[2] ?? "recon-ar") as BriefType;

async function main() {
  const r = await buildBrief(type, { dryRun: true });
  console.log(`WOULD SEND TO: ${(r.wouldSendTo ?? []).join(", ")}`);
  console.log(`SUBJECT: ${r.subject}`);
  console.log("─".repeat(70));
  console.log(r.bodyText);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
