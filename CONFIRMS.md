# CONFIRMS — Mark — open questions before the agent runs against real data

Each item below is a question the build spec (CLAUDE.md) flags as a `CONFIRM`,
plus anything I hit during the build. The agent boots without these answers but
each one has a default that may or may not match what you actually want.

Order = priority (highest first).

---

## C1 — Q&A channel (spec §4 Function E, §7)

**Question.** Where do team members ask Mark questions? Two options on the
table per spec:

1. **`dashboard-chat`** — a `/qa` page in this app, behind Basic auth. Already
   built. Each Q+A persisted to `FinanceQuery`. Default.
2. **`helpdesk`** — wire into the JBC helpdesk / Slack / Teams channel and
   surface answers there. Not built — adds an inbound webhook + outbound bot.

**Default picked:** `MARK_QA_CHANNEL=dashboard-chat`. The `/qa` page is live.

**Status:** OPEN. Confirm whether Tony also wants the helpdesk route — if yes
that's a Phase-7 add.

---

## C2 — Goal targets

Mark needs target values for the goal metrics he tracks. Defaults in env:

```
GOAL_PROFIT_TARGET_AUD=3000000              # Tony's $3M target — confirmed in spec
GOAL_LABOUR_COST_TARGET_PCT_SC=72           # placeholder
GOAL_LABOUR_COST_TARGET_PCT_CQ=72           # placeholder
GOAL_DSO_TARGET_DAYS=35                     # placeholder
```

The profit target is in the spec. The other three are placeholders I picked
based on industry norms for home care; confirm with Tony / external accountant
and update in Railway.

**Status:** OPEN for the three non-profit targets.

---

## C3 — Brief recipient lists

All four recipient env vars default empty. When empty, the channel guard logs
"skipped: no recipients" but doesn't error — useful for dry runs but Tony will
want real lists before going live.

```
MARK_DAILY_RECIPIENTS=tony@..., nicole@...
MARK_RESTRICTED_RECIPIENTS=tony@..., lindsay@..., nicole@...
MARK_WEEKLY_RECIPIENTS=tony@..., christina@..., melissa@..., lindsay@...
MARK_MONTHLY_RECIPIENTS=tony@..., accountant@...
MARK_HEARTBEAT_RECIPIENTS=tony@...
```

**Question to settle before first live brief.**

1. **Which Lindsay address?** `@justbettercare.com` (JBCA) or
   `@justbettercareqld.com.au`?
2. **External accountant — name + email?**
3. **Christina + Melissa addresses** for the weekly?

**Status:** OPEN — leave empty in dev, populate in Railway before flipping
the daily cron.

---

## C4 — Brief cadence (spec §7)

Defaults:

```
MARK_DAILY_BRIEF_TIME=07:00          # 07:00 AEST → cron 21:00 UTC
MARK_WEEKLY_REPORT_DAY=1             # 1=Mon
MARK_MONTHLY_PACK_DAY=3              # 3rd of the month
MARK_SPECIALIST_STALE_HOURS=36
```

The cron sidecar only ships ONE Railway cron schedule by default (poll every
30 min). Tony adds three more cron services in the Railway dashboard for the
three briefs, with `MARK_ACTION=brief` and `MARK_BRIEF_TYPE=daily|weekly|monthly`.
The `ping.sh` script supports both modes — see `cron/railway.toml` comments.

**Status:** OPEN — confirm Tony likes 07:00 / Mon / 3rd, then set the three
extra cron services.

---

## C5 — Restricted routing — names + email split

Spec section 2.5 + 6b: people-flag goes to Tony + Lindsay; individual-pay goes
to Tony + Nicole. Today both are merged into `MARK_RESTRICTED_RECIPIENTS`
because the dashboard's `IngestedFinding` does not yet distinguish people vs
pay subtypes — the restricted brief simply sends everything restricted to the
combined list.

**Options when this becomes a problem:**

A. **Subtype field on the brief.** Split restricted into two emails (one for
   people, one for pay) by detector / source agent. Cheap to add; adds another
   env var.

B. **Single list, both audiences.** Today's behaviour. Easier to reason about;
   means Lindsay sees pay items + Nicole sees people items.

**Default picked:** B (single list). Cleaner v1; revisit when Tony has a
specific case where he wants the split.

**Status:** OPEN.

---

## C6 — Conflict-detection heuristics

`lib/mark/conflict.ts` ships three heuristics:

1. **Cash vs tax** — Reconciliation `cash-position` < Tax `cash-set-aside` /
   `gst-cover` / `bas-cover` for the same entity = conflict (today). Detector
   names assumed; specialists must emit detectors matching these regexes for
   the heuristic to fire. **Confirm with Recon + Tax agent owners.**
2. **Amount ratio > 2×** within a correlation group across agents = conflict.
   Reasonable starting point — adjust if it noises up.
3. **Resolution disagreement** — one agent says resolved, another says open
   for the same identifier = conflict.

**Status:** OPEN — heuristics #1 in particular needs Recon + Tax detector
naming to match. Heuristic #2 threshold may need tuning.

---

## C7 — Correlation identifier keys

`lib/mark/correlate.ts` uses a fixed list of evidence keys to find "this is
the same supplier / invoice / participant across two findings":

```
vendorId, vendor_id, contactXeroId, contact_xero_id, supplierId, supplier_id,
invoiceId, invoice_id, billId, bill_id,
participantId, participant_id, clientId, client_id,
employeeId, employee_id, personId, person_id,
bankAccountId, bank_account_id, abn, ABN
```

Specialists that don't put these keys in their `evidence` payload will not
correlate with peers. The 7 specialists need to honour at least the first
identifier for each entity kind (supplier/invoice/participant/employee/bank).

**Status:** OPEN — track which specialists currently emit which keys and
backfill where missing.

---

## C8 — Anthropic model

Default `ANTHROPIC_MODEL=claude-sonnet-4-6` (matches the other agents). The
spec leaves it open; Opus is heavier and slower but better at the narrative
tone. Worth re-trying on Opus once we see the first real-data brief and
decide if Sonnet's tone is good enough.

**Status:** OPEN.

---

## C9 — Restricted username default split

`MARK_RESTRICTED_USERNAMES=tony,lindsay,nicole` includes all three. As long as
they share one list (C5 option B), that's right. If we move to C5 option A,
this splits into `MARK_RESTRICTED_PEOPLE_USERNAMES=tony,lindsay` and
`MARK_RESTRICTED_PAY_USERNAMES=tony,nicole`.

**Status:** linked to C5.

---

## C10 — Specialist URLs

The seven `SPECIALIST_*_URL` env vars are blank by default. Without them Mark
records `failed: no SPECIALIST_<X>_URL configured` against the corresponding
SpecialistRunStatus, which surfaces as "stale" / its-own-finding on the daily
brief — exactly the watchdog behaviour we want when a specialist is silent.

Production URLs (Railway projects already deployed):

- Reconciliation: confirm exact `https://...up.railway.app`
- Controls & Audit: `https://controls-audit-agent-production.up.railway.app`
- Payroll & Labour: not yet deployed — placeholder
- Payables: not yet deployed — placeholder
- Revenue & Claims: not yet deployed — placeholder
- Receivables: not yet deployed — placeholder
- Tax & Compliance: not yet deployed — placeholder

**Status:** OPEN — populate the 7 env vars in Railway as each specialist
lights up. `MARK_MOCK=true` is the fallback for end-to-end testing today.

---

## C11 — Profit run-rate consolidation

Spec section 6d wants "consolidated AND per-entity P&L view". Today Mark only
records `entityScope` as whatever the goal-input finding declared
(`SC` / `CQ` / `BOTH`). True consolidated P&L (sum SC + CQ for management,
keep separate for statutory) is the right shape but requires the specialists
to emit BOTH per-entity AND aggregate `goal:profit-run-rate` rows, OR Mark
to sum them himself.

**Default picked:** Mark trusts whatever the specialist sends. If a
`BOTH` row comes in, that's the consolidated. If only SC + CQ come in, Mark
shows them side-by-side and does NOT sum (avoids inventing a number).

**Status:** OPEN — confirm one of: (a) specialists emit BOTH rows where
needed, (b) Mark sums SC + CQ to produce a consolidated, (c) the dashboard
displays both per-entity values and lets the human consolidate in their head.

---

## C12 — Polling include_people behaviour

`lib/mark/poll.ts` calls each specialist with `?include_people=1` so Mark sees
people findings (he needs them to route the restricted brief). The channel
guard at email time keeps them off non-restricted briefs. This means HUB_API_KEY
holders can read people findings — which is fine for Mark, but worth confirming
the specialists are comfortable with Mark having that key.

**Status:** OPEN — confirm with each specialist owner that HUB_API_KEY ⇒
include_people is acceptable. Alternative: split `HUB_API_KEY` into
`HUB_API_KEY_OPS` + `HUB_API_KEY_RESTRICTED` and have Mark hold both.

---

## C13 — One DB or shared DB?

Spec section 3 says Mark "shares the same database" as the specialists. Today
each specialist (recon, controls-audit) has its OWN Railway Postgres. The
Hermes-shape feedback file in MEMORY.md is explicit: do NOT push to a central
hub. So Mark uses HIS OWN database to cache ingested findings + write briefs.
This is what's built.

**Status:** RESOLVED to the Hermes shape — Mark has his own DB, polls
specialists via HTTP, never touches their DBs directly.
