// Manual brief build — `npm run mark:brief -- <type>`.
//
// Types: daily | restricted | weekly | monthly.

import { buildBrief, type BriefType } from "../lib/mark/brief";

function parseType(s: string | undefined): BriefType {
  if (s === "daily" || s === "restricted" || s === "weekly" || s === "monthly") return s;
  throw new Error(`brief type required: daily | restricted | weekly | monthly (got: ${s ?? "(none)"})`);
}

async function main() {
  const t = parseType(process.argv[2]);
  const r = await buildBrief(t);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
