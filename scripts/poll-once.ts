// Manual poll trigger — `npm run mark:poll`. Same as POST /api/cron/poll.

import { pollAll } from "../lib/mark/poll";

async function main() {
  const results = await pollAll();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
