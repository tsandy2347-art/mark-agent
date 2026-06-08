# CLAUDE.md — JBC Finance System: Finance Manager Agent ("Mark")

> **For Claude Code.** Complete build spec for the orchestrator of the JBC Finance
> Agent system. This is the **last** thing built — only after all 7 specialists
> exist and work. Build it as specified. Where you see **CONFIRM**, flag the
> assumption back to Tony rather than guessing silently.

---

## 1. What this is

**Mark** is the Finance Manager Agent — the orchestrator. He is not a specialist
and he does not crunch numbers himself. Mark's job is the job a good finance
manager actually does: task the team, collect what they find, resolve conflicts
between them, decide what matters, escalate the right things to the right people,
and turn the whole picture into clear reporting for Tony and the team.

Mark exists so that Tony does not receive seven separate agent reports every day.
He receives one, from Mark, and Mark has already done the thinking about what is
important and what can wait.

### Why Mark is built last
An orchestrator with no team to orchestrate is a manager with an empty office.
Mark is only built once the 7 specialists exist, because his entire design — what
he reads, what he tasks, what he synthesises — is defined by them. Building him
last means his job spec writes itself from real specialist output, not guesswork.

### The team Mark manages
| # | Agent | Owns |
|---|-------|------|
| 1 | Reconciliation Agent | Bank rec, cash position, intercompany, journal integrity |
| 2 | Controls & Audit Agent | SoD, related-party signals, fraud monitoring |
| 3 | Payroll & Labour Agent | SCHADS award, pay-line integrity, labour cost |
| 4 | Payables Agent | Supplier invoices, AP, payment run preparation |
| 5 | Revenue & Claims Agent | NDIS / SaH claiming, revenue leakage |
| 6 | Receivables Agent | AR, debtor follow-up, collections |
| 7 | Tax & Compliance Agent | GST, BAS, PAYG, payroll tax, super |

### The two entities
| Code | Legal name |
|------|-----------|
| SC | Just Better Care Sunshine Coast Pty Ltd |
| CQ | Just Better Care Central Queensland Pty Ltd |

Mark reports per entity **and** consolidated. Consolidated is for management
insight only — never for statutory purposes (the two entities are separate
taxpayers).

---

## 2. Non-negotiable guardrails

1. **Mark inherits every specialist's limits.** He cannot do, authorise, or
   release anything a specialist could not. He does not pay, lodge, send, approve,
   write off, or move money. Orchestration does not unlock new powers — if the
   team cannot do a thing, neither can the boss.
2. **Escalate, never act.** Mark's output is reporting and prioritised exceptions.
   Every decision belongs to a human: Tony, Nicole, or the external accountant.
3. **Mark synthesises, he does not overrule the maths.** If a specialist's figure
   is wrong, the fix is in that specialist, not a quiet correction by Mark. Mark
   may flag that two specialists disagree; he does not silently pick a winner.
4. **Read-mostly.** Mark reads the shared database. He writes only his own
   orchestration records, briefs, and consolidated reports. He never edits a
   specialist's data or any source system.
5. **Respect restricted routing.** People flags (from the Controls & Audit Agent)
   and individual pay data (from the Payroll Agent) keep their restricted
   recipient lists when Mark handles them. Mark does not widen an audience.
6. **Human accountability stays human.** Mark replaces the *workload* of a finance
   manager, not the *accountability*. Statutory sign-off, payment release, and
   judgement calls remain with named humans. Mark makes those humans faster and
   better informed; he does not become them. This is stated plainly so it is not
   quietly eroded over time.
7. **Auditable.** Every brief Mark produces stores which specialist runs and
   exceptions it drew on.

---

## 3. Tech stack

Identical to the rest of the finance system. Mark lives on the same stack and
shares the same database — that shared database is the whole reason orchestration
is cheap.

- **Hosting:** Railway
- **App:** Next.js (App Router) + TypeScript
- **DB:** PostgreSQL via Prisma — the **shared** finance database
- **AI:** Anthropic API (Claude) for synthesis, prioritisation, narrative writing,
  and answering natural-language questions
- **Sources:** the shared `Exception` model and every specialist's data tables;
  Mark calls **no external system directly**
- **Scheduling:** Railway cron (daily, weekly, monthly cycles)

---

## 4. What Mark does (6 functions)

### Function A — Orchestration and scheduling
- Run the specialists on the right cadence, or read their already-run output, and
  know when each last ran successfully.
- If a specialist failed to run or returned an error, that is itself a
  critical item in Mark's brief — a blind spot is a finding.

### Function B — Synthesis and prioritisation
- Read every open exception across all 7 specialists from the shared `Exception`
  model.
- De-duplicate and **correlate**: when two agents flag the same underlying thing
  (e.g. Payables quarantines an invoice and Controls & Audit flags the same
  vendor's bank change), Mark presents it as **one** issue, not two.
- Prioritise: rank what actually needs a human today versus this week versus
  noting. Severity from the specialists is the input; Mark's job is the judgement
  of relative importance across the whole picture.

### Function C — Conflict resolution
- When specialists disagree (e.g. the Reconciliation Agent's cash figure and the
  Tax Agent's assumed cash-set-aside do not line up), Mark surfaces the
  discrepancy clearly and routes it for human resolution. He does not hide it and
  does not silently choose.

### Function D — Consolidated reporting
- Produce the unified daily, weekly, and monthly reports (section 6) — one
  coherent picture, per entity and consolidated, in plain English.
- This is where the seven streams become one readable story for Tony and the team.

### Function E — Natural-language finance Q&A
- Answer plain-English questions from Tony or the team against the shared data:
  "what's CQ's cash position", "how much revenue did we leave unclaimed last
  month", "are we on track for the BAS". Mark queries the specialists' data and
  answers — with figures, in plain language.
- **CONFIRM** the channel for this: the JBC Helpdesk / team chat, or a chat panel
  in the finance dashboard.

### Function F — Performance and goal tracking
- Track the metrics that matter to Tony's goals: profit trajectory toward the
  **$3M target**, labour cost percentage, revenue leakage closed, DSO, GST
  position. Trend them and report progress honestly — including when the trend is
  going the wrong way.

---

## 5. Data model (Prisma)

Mark adds a small set of orchestration models on top of the shared schema. He does
**not** redefine the shared `Exception` model — he reads it.

```prisma
model SpecialistRunStatus {
  id              String   @id @default(cuid())
  agent           String   // "reconciliation" | "controls-audit" | ...
  lastRunAt       DateTime?
  lastRunStatus   String   // "ok" | "exceptions" | "failed" | "stale"
  exceptionsOpen  Int      @default(0)
  updatedAt       DateTime @updatedAt
}

model FinanceBrief {
  id              String   @id @default(cuid())
  briefType       String   // "daily" | "weekly" | "monthly"
  entityScope     String   // "SC" | "CQ" | "consolidated"
  generatedAt     DateTime @default(now())
  headline        String
  narrative       String   // the plain-English synthesis
  sourcedRunIds   Json     // which specialist runs this drew on, for audit
  itemsForAction  Json     // prioritised, correlated issues
}

model CorrelatedIssue {
  id              String   @id @default(cuid())
  briefId         String
  title           String
  detail          String
  priority        String   // "today" | "this-week" | "note"
  sourceAgents    Json     // which specialists contributed
  sourceExceptionIds Json  // the underlying shared-Exception records
  isRestricted    Boolean  @default(false)  // people / pay data routing
  resolved        Boolean  @default(false)
}

model GoalMetric {
  id              String   @id @default(cuid())
  metric          String   // "profit-run-rate" | "labour-cost-pct" | "dso" | "unclaimed-revenue" | "net-gst"
  entityScope     String
  periodLabel     String
  value           Decimal
  target          Decimal?
  trend           String   // "improving" | "flat" | "worsening"
  capturedAt      DateTime @default(now())
}

model FinanceQuery {
  id              String   @id @default(cuid())
  askedBy         String
  question        String
  answer          String
  dataAsOf        DateTime
  createdAt       DateTime @default(now())
}
```

---

## 6. The reports — one voice for the whole function

Mark replaces seven inboxes' worth of agent output with three clear reports.

### 6a. Daily finance brief
- Recipients: **Tony and Nicole**.
- One page. Headline first: is anything on fire. Then: cash position both
  entities, the prioritised "needs you today" list (correlated, de-duplicated),
  any specialist that failed to run. Restricted items summarised here only as
  "1 restricted item — see separate brief".

### 6b. Restricted brief
- Recipients: **Tony, plus Lindsay for people matters / Nicole for pay matters**.
- Anything carrying people flags or individual pay data, kept on its proper
  channel. Sent only when there is something.

### 6c. Weekly team report
- Recipients: **Tony and the relevant team** (Christina, Melissa, Lindsay get the
  sections relevant to them).
- The week across all functions: revenue, labour, AP, AR, controls, tax — each a
  short readable section, aggregate figures, no individual data.

### 6d. Monthly finance pack
- Recipients: **Tony and the external accountant**.
- The full picture: consolidated and per-entity P&L view, cash flow, the goal
  metrics against target including the $3M trajectory, the month's exceptions and
  how they resolved. This is the pack a finance manager would have walked Tony
  through — now Mark assembles it and a human reviews and signs off.

> Mark drafts and delivers to these fixed lists only. He sends nothing to
> suppliers, debtors, participants, the ATO, or anyone outside JBC.

---

## 6e. Chart of accounts (durable reference, NOT Honcho)

Mark's chart of accounts for SC + CQ lives in this repo, not in Honcho. Honcho
is the deriver-built memory layer for cross-session facts about the user — it's
not a reliable key/value store for authoritative reference data, so codes that
must be exact (Xero account codes, tax treatments) live here:

```
data/chart-of-accounts/
  sc.csv        # raw Xero export — Just Better Care Sunshine Coast Pty Ltd
  cq.csv        # raw Xero export — Just Better Care Central Queensland Pty Ltd
lib/
  chart-of-accounts.ts            # typed accessors + formatChartForPrompt(entity)
  chart-of-accounts.generated.ts  # auto-generated, do not edit
scripts/
  build-chart.ts                  # CSV → generated TS (npm run build:chart)
```

To refresh after a chart change in Xero: re-export the chart, replace the CSV
in place, run `npm run build:chart`, commit both the CSV and the generated TS.
The build filters out non-postable placeholder rows ("HP NAME1", "Ben 1
Beneficiary", "DO NOT USE", template asset descriptions, etc.) so the prompt
stays tight.

The propose route (`app/api/journals/propose/route.ts`) injects the
entity-specific block into the system prompt with `cache_control: ephemeral`
so the per-entity chart caches across consecutive calls. The route also
cross-checks every code the model returns against the chart and surfaces
`unknownCodes` on the response so the UI can flag invented codes loudly.

The payroll-journal build (recon-owned) does NOT need this — it uses the
hard-coded Craig pattern codes (477/477.4/478/478.1/803/825/826/877). The
chart matters for the free-form propose path.

---

## 7. Configuration

```
# Shared finance database
DATABASE_URL=

# Anthropic
ANTHROPIC_API_KEY=

# Cadence
MARK_DAILY_BRIEF_TIME=
MARK_WEEKLY_REPORT_DAY=
MARK_MONTHLY_PACK_DAY=

# Staleness — a specialist not run within this window is flagged "stale"
MARK_SPECIALIST_STALE_HOURS=36

# Q&A channel — CONFIRM
MARK_QA_CHANNEL=                 # "helpdesk" | "dashboard-chat"

# Goal targets — CONFIRM
GOAL_PROFIT_TARGET_AUD=3000000
GOAL_LABOUR_COST_TARGET_PCT=     # CONFIRM per entity

# Report routing
MARK_DAILY_RECIPIENTS=tony@...,nicole@...
MARK_RESTRICTED_RECIPIENTS=tony@...,lindsay@...,nicole@...
MARK_WEEKLY_RECIPIENTS=tony@...,christina@...,melissa@...,lindsay@...
MARK_MONTHLY_RECIPIENTS=tony@...,accountant@...
```

---

## 8. Build phases

- **Phase 1 — Plumbing.** Next.js on Railway against the shared finance database,
  Prisma orchestration models. Done when: Mark can read every specialist's
  exceptions and run status.
- **Phase 2 — Run orchestration and status (Function A).** Mark knows what ran,
  what failed, what is stale.
- **Phase 3 — Synthesis, correlation, prioritisation (Functions B, C).** The core
  of Mark — de-duplicate, correlate, rank, surface conflicts.
- **Phase 4 — Consolidated reporting (Function D).** The four reports.
- **Phase 5 — Natural-language Q&A (Function E).** On the confirmed channel.
- **Phase 6 — Goal tracking (Function F) and the finance dashboard.** A single
  finance command-centre page: cash, exceptions by priority, goal metrics, the
  Q&A panel, specialist health.

---

## 9. The finished system

With Mark built, the JBC Finance Agent system is complete:

- **7 specialists** doing the grunt work, each writing to one **shared `Exception`
  model** so they speak one language.
- **Mark** on top, turning seven streams into one prioritised, plain-English
  picture and answering questions on demand.
- **Humans where they must be:** Nicole operating and approving, the external
  accountant signing off statutory returns, Tony deciding and steering. Payment
  release, lodgement, and judgement calls never left them.

The system replaces the **workload** of a Finance Manager — and, given a watchdog
that never sleeps and reconciliation that runs daily, delivers **better controls**
than the arrangement it replaces. It does not replace human accountability, and is
not designed to. Keep the external accountant genuinely in the loop: they are the
independent check that the agents are right, and that check is a feature of the
design, not an optional extra.

---

## 10. Definition of done

- Mark reads all 7 specialists from the shared database and knows each one's run
  health.
- Exceptions are de-duplicated and correlated — one underlying issue is one item,
  not seven.
- Conflicts between specialists are surfaced for human resolution, never hidden.
- One daily brief, one weekly report, one monthly pack — replacing seven separate
  agent outputs — in plain English, per entity and consolidated.
- Restricted people and pay data keep their restricted routing.
- Natural-language finance questions are answered accurately from live data.
- Goal metrics, including the $3M profit trajectory, are tracked honestly.
- Mark holds no power his specialists lack; he escalates, he never acts.
- Every brief is auditable to its source runs.
- A failed or stale specialist is itself a flagged finding.
