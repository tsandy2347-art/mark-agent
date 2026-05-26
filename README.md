# Mark — JBC Finance Manager Agent

The orchestrator across the 7 JBC Finance specialists (Reconciliation,
Controls & Audit, Payroll & Labour, Payables, Revenue & Claims, Receivables,
Tax & Compliance). Mark synthesises seven streams into one prioritised,
plain-English picture, surfaces conflicts between specialists, and tracks
goals (profit toward $3M, labour cost %, DSO, GST, unclaimed revenue).

- **Full spec:** [CLAUDE.md](./CLAUDE.md)
- **Open questions:** [CONFIRMS.md](./CONFIRMS.md)

## What Mark does

1. **Polls each specialist** every 30 min via its `/api/findings` endpoint
   (Bearer `HUB_API_KEY`) and caches the result in `IngestedFinding`.
2. **Correlates + prioritises** open findings — one underlying issue is one
   card, even when 2+ specialists touched it.
3. **Detects conflicts** when two specialists disagree about a fact (cash vs
   tax assumption, amount mismatch, resolution disagreement).
4. **Assembles four briefs** (daily / restricted / weekly / monthly) and
   delivers them to the configured recipient lists via SES.
5. **Tracks goal metrics** — picks up `goal:<metric>` findings from the
   specialists, computes trend, stores `GoalMetric` rows.
6. **Answers questions** in plain English from the ingested data at `/qa` and
   `POST /api/qa`.

## What Mark does NOT do

- Pay, lodge, send, approve, release, or write off anything.
- Edit a specialist's data, or any source system.
- Overrule a specialist's maths — if two disagree, the conflict is surfaced
  for a human.
- Send anything to suppliers, debtors, participants, or the ATO.
- Leak restricted (people / individual pay) content onto the daily, weekly,
  or monthly brief — the channel guard in `lib/email.ts` throws if you try.

## Run locally

```bash
# 1. Install
npm install

# 2. Generate the Prisma client (requires DATABASE_URL pointing at a Postgres)
DATABASE_URL=postgresql://user:pass@localhost:5432/mark npx prisma generate

# 3. Migrate (or push)
DATABASE_URL=... npx prisma db push

# 4. Boot
DATABASE_URL=... MARK_MOCK=true npm run dev
```

Visit http://localhost:3000 — the dashboard renders even before any specialist
is wired, thanks to `MARK_MOCK=true` using canned fixtures.

## Mock mode

`MARK_MOCK=true` short-circuits the poll path to use canned fixtures from
`lib/mark/mock/fixtures.ts`. The fixtures exercise every code path: critical
findings, restricted (people-flag), cross-agent correlation (same supplier in
Payables + Controls), conflict detection (recon cash < tax cash-set-aside),
goal metric capture.

```bash
MARK_MOCK=true npm run mark:poll
MARK_MOCK=true npm run mark:brief -- daily
```

## Production environment

The seven `SPECIALIST_*_URL` env vars point Mark at each specialist's
Railway URL. A specialist with a blank URL is recorded as "failed: no URL
configured" — silence is its own finding. Set them in the Railway dashboard
as each specialist deploys.

Cron sidecars: the default `cron/` sidecar polls every 30 min
(`MARK_ACTION=poll`). For the four brief schedules (daily / restricted /
weekly / monthly), stand up additional cron services in Railway with
`MARK_ACTION=brief` + `MARK_BRIEF_TYPE=<type>` and the appropriate
`cronSchedule` — see comments in `cron/railway.toml`.

## Ordering caveat

Mark depends on at least one specialist URL being reachable to do anything
useful in production. He boots and dashboards cleanly without any — but the
daily brief will simply say "all specialists silent — investigate before
trusting this picture", which is the correct behaviour for a watchdog with
no team yet.

## Routes summary

- `GET /` — today's dashboard (basic auth)
- `GET /briefs` + `GET /briefs/[id]` — brief history (basic auth)
- `GET /specialists` — health of all 7 (basic auth)
- `GET /goals` — goal metrics + history (basic auth)
- `GET /qa` — chat UI for Q&A (basic auth)
- `GET /restricted` — restricted items, gated to `MARK_RESTRICTED_USERNAMES`
- `POST /api/qa` — Q&A endpoint (basic auth, restricted findings included if
  caller is in `MARK_RESTRICTED_USERNAMES`)
- `POST /api/cron/poll` — sweep all 7 specialists (Bearer `CRON_SECRET`)
- `POST /api/cron/brief` — `{ briefType }` build + deliver one brief (Bearer
  `CRON_SECRET`)
- `POST /api/correlated/[id]/resolve` — close a correlated issue
- `GET /api/healthz` — Railway healthcheck
