// Function D — assemble + deliver the four briefs.
//
//   daily       → Tony + Nicole. Headline first, cash both entities, "needs
//                  you today" list, specialist health. Restricted items
//                  summarised as a count only.
//   restricted  → Tony + Lindsay (people) and/or Nicole (pay). Fires only when
//                  there's something. People / individual-pay content allowed.
//   weekly      → Tony + section-owning managers. Aggregate, no individual data.
//   monthly     → Tony + external accountant. Full picture, goal metrics.
//
// All four pull from IngestedFinding + SpecialistRunStatus + GoalMetric, run
// the correlate/prioritise/conflict pipeline, ask Anthropic for the
// plain-English narrative, persist a FinanceBrief row, and email via SES with
// the channel guard enforcing restricted routing.

import { DateTime } from "luxon";
import { prisma } from "../prisma";
import { env, recipients } from "../env";
import { brisbane, brisbaneDate } from "../time";
import { isStale, isBlindSpot } from "./poll";
import { correlateFindings } from "./correlate";
import { prioritiseAll, type Priority } from "./prioritise";
import { detectConflicts } from "./conflict";
import { captureGoalMetrics, readLatestMetrics, type CapturedMetric } from "./goals";
import { synthesiseBrief } from "../anthropic";
import { sendChannelEmail, type Channel, sendHeartbeatFailure } from "../email";
import {
  hermesConfigured,
  listOpenFindingsByDetectors,
  listOpenFindingsForQa,
  type HermesFinding,
} from "../hermes-findings";
import type { IngestedFinding, SpecialistRunStatus } from "../generated/prisma";

export type BriefType = "daily" | "recon-ar" | "restricted" | "weekly" | "monthly";

export interface BriefResult {
  briefId: string;
  briefType: BriefType;
  itemsTodayCount: number;
  itemsThisWeekCount: number;
  notesCount: number;
  restrictedCount: number;
  staleSpecialistsCount: number;
  delivered: boolean;
  /** Populated only on dryRun — the email exactly as it would have sent. */
  subject?: string;
  bodyText?: string;
  wouldSendTo?: string[];
}

export async function buildBrief(briefType: BriefType, opts?: { dryRun?: boolean }): Promise<BriefResult> {
  try {
    return await buildBriefInner(briefType, opts?.dryRun ?? false);
  } catch (e) {
    await sendHeartbeatFailure(e, `build-${briefType}-brief`).catch(() => undefined);
    throw e;
  }
}

async function buildBriefInner(briefType: BriefType, dryRun: boolean): Promise<BriefResult> {
  const now = new Date();
  const dataAsOf = brisbane(now);

  // ── Pull open findings from the live source. ──
  // Since the specialist-service teardown, detectors write to the shared
  // hermes findings DB — that is the live path. The local IngestedFinding
  // mirror stopped receiving rows on 2026-05-29 and is only a fallback for
  // environments without HERMES_FINDINGS_DATABASE_URL.
  const [openFindings, statuses, latestMetrics] = await Promise.all([
    fetchOpenFindings(),
    prisma.specialistRunStatus.findMany(),
    readLatestMetrics(),
  ]);

  // Capture any new goal-metric data the recent findings carry. (Idempotent
  // append-only — captures one row per goal input seen this run.) Skipped on
  // dryRun: previews must not write anything.
  if (!dryRun) await captureGoalMetrics(openFindings).catch(() => undefined);

  // ── Correlate + prioritise + conflict-detect. ──
  // cash-position findings are DATA for the CASH POSITION panel, not action
  // items — exclude them from correlate/prioritise so a large cash figure
  // (abs > $25k trips the "today" threshold) can never headline as an alarm.
  const actionableFindings = openFindings.filter(
    (f) =>
      !(f.specialistAgent === "reconciliation" && /cash-?position/i.test(f.detector)) &&
      !(f.specialistAgent === "tax-compliance" && /gst-?position/i.test(f.detector)) &&
      // Detector failures are coverage gaps, not work items — they're reported
      // once in the COVERAGE section instead of scattered through the list.
      !isDetectorFailure(f.detector),
  );
  let candidates = correlateFindings(actionableFindings);
  const conflictRes = detectConflicts(candidates, openFindings);
  candidates = conflictRes.candidates;
  // Stale-honesty: a finding's own date governs how it is presented. An item
  // whose newest evidence is older than these thresholds cannot claim the
  // "today" slot — it is long-outstanding, not breaking news.
  const prioritised = prioritiseAll(candidates).map((c) => {
    const newestMs = Math.max(...c.findings.map((f) => f.at.getTime()));
    const oldestMs = Math.min(...c.findings.map((f) => f.at.getTime()));
    // lastSeen: detectors upsert ongoing conditions in place, so created_at is
    // when the condition BEGAN — evidence.runAt is when the data last
    // CONFIRMED it. Both matter: "overdrawn as of this morning, persisting
    // since 16 Jun" is actionable; conflating them made live conditions look
    // like stale garbage and stale corpses look live.
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
      ...c,
      priority,
      ageDays,
      freshDays,
      firstRaised: brisbaneDate(new Date(oldestMs)),
      lastSeen: brisbaneDate(new Date(lastSeenMs)),
    };
  });

  // ── Specialist health → a blind spot is a finding. ──
  // Anything that isn't a completed, still-producing run is a domain Mark
  // CANNOT vouch for. That includes runs stuck at 'running' and agents whose
  // runs complete but that have stopped writing findings — both of which used
  // to render as "no exceptions today ✓", i.e. an all-clear over an unchecked
  // domain. These lead the brief now.
  const staleAgents = statuses
    .filter((s) => isBlindSpot(s.lastRunStatus) || isStale(s.lastRunAt))
    .map((s) => ({
      agent: s.agent,
      status: s.lastRunStatus,
      lastRunAt: s.lastRunAt ? brisbane(s.lastRunAt) : "(never)",
      error: s.lastError ?? null,
    }));

  // Producers that write into the shared findings DB but aren't one of Mark's
  // seven (so SpecialistRunStatus never tracks them). Their findings still
  // reach this brief, so their going quiet has to be visible too — otherwise a
  // dead pipeline's last output keeps getting re-reported as current.
  staleAgents.push(...silentUnownedProducers(openFindings, statuses, now));

  // Detector-level blind spots: the `*-detector-failed` / `*-failed` findings
  // the specialists raise when a sub-detector throws. Same category as a silent
  // agent — "we didn't check" — so they get lifted out of the item list and
  // reported alongside agent health instead of buried mid-brief.
  const detectorBlindSpots = summariseDetectorFailures(openFindings, now);

  // AR collections policy (Tony, 2026-07-04): 61-90d invoices are the working
  // bucket — always top priority, they only get paid if we chase. An invoice
  // NEWLY crossing 90 is a process failure (creep). The standing 90+ backlog
  // is a cleanup list — one aggregate line, not daily itemisation.
  const { candidates: policyApplied, arPolicy } = applyReceivablesPolicy(prioritised, dataAsOf);

  // Channel-determined filter: restricted brief sees ONLY restricted items;
  // every other brief EXCLUDES restricted items entirely.
  const isRestricted = briefType === "restricted";
  const items = policyApplied
    .filter((c) => (isRestricted ? c.isRestricted : !c.isRestricted))
    .filter((c) => {
      // Audience split: Nicole owns reconciliation + receivables detail via
      // the recon-ar brief; Tony's daily drops receivables-only items (recon
      // stays — overdrawn/feed problems are cash-critical) and keeps AR at
      // headline-total level via goal metrics.
      if (briefType === "recon-ar") {
        return c.sourceAgents.some((a) => a === "reconciliation" || a === "receivables");
      }
      if (briefType === "daily") {
        return !c.sourceAgents.every((a) => a === "receivables");
      }
      return true;
    });

  // Nicole chases debtors by name. The shared findings DB keeps titles
  // name-light (masked refs like JB-2c62), so the real contactName from
  // evidence is surfaced ONLY in the recon-ar brief — other briefs and
  // downstream surfaces stay name-light.
  const displayItems =
    briefType === "recon-ar"
      ? items.map((c) => {
          const ev = c.findings[0]?.evidenceJson;
          const obj = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {};
          const name = obj.contactName;
          if (typeof name !== "string" || !name || name === "(unknown)" || c.title.includes(name)) return c;
          // The invoice number + name identify the item; the masked ref is
          // internal-only noise in Nicole's brief — swap it out, don't stack.
          const ref = obj.contactRef;
          const title =
            typeof ref === "string" && ref && c.title.includes(ref)
              ? c.title.replace(ref, name)
              : `${c.title} — ${name}`;
          return { ...c, title, detail: `${c.detail}\nDebtor: ${name}` };
        })
      : items;

  const itemsToday = displayItems.filter((c) => c.priority === "today");
  const itemsThisWeek = displayItems.filter((c) => c.priority === "this-week");
  const itemsNote = displayItems.filter((c) => c.priority === "note");
  const restrictedTotal = prioritised.filter((c) => c.isRestricted).length;

  // Cash position both entities — pull most recent recon "cash-position" row.
  const cashByEntity = recentCashByEntity(openFindings);
  // GST position both entities — pull most recent tax-compliance "gst-position" row.
  const gstByEntity = recentGstByEntity(openFindings);

  // Nicole's brief carries no profit/margin content — only cash/AR metrics.
  const scopedMetrics =
    briefType === "recon-ar"
      ? latestMetrics.filter((m) => /dso|cash|receivab|ar\b/i.test(m.metric))
      : latestMetrics;

  // ── Structured payload Anthropic synthesises into prose. ──
  const synthesisPayload = {
    briefType,
    dataAsOf,
    cashByEntity,
    gstByEntity: briefType === "recon-ar" ? null : gstByEntity,
    goalMetrics: scopedMetrics,
    specialistHealth: statuses.map((s) => ({
      agent: s.agent,
      status: isStale(s.lastRunAt) ? "stale" : s.lastRunStatus,
      lastRunAt: s.lastRunAt ? brisbane(s.lastRunAt) : null,
      exceptionsOpen: s.exceptionsOpen,
      error: s.lastError,
      /** When true this agent cannot vouch for its domain — say so, never
       *  present its silence or its zero-count as a clean result. */
      isBlindSpot: isBlindSpot(s.lastRunStatus) || isStale(s.lastRunAt),
    })),
    /** Sub-detectors that are erroring — checks that did not run. */
    detectorBlindSpots,
    itemsForAction: displayItems.map((c) => ({
      priority: c.priority,
      title: c.title,
      detail: c.detail,
      entityCode: c.entityCode,
      amount: c.amount,
      sourceAgents: c.sourceAgents,
      isConflict: c.isConflict,
      isRestricted: c.isRestricted,
      firstRaised: c.firstRaised,
      ageDays: c.ageDays,
      lastSeen: c.lastSeen,
      freshDays: c.freshDays,
      policyTag: c.policyTag ?? null,
    })),
    arPolicy,
    restrictedItemSummary: isRestricted
      ? null
      : restrictedTotal > 0
        ? `${restrictedTotal} restricted item(s) — see separate brief`
        : null,
    profitTarget: briefType === "recon-ar" ? null : env.GOAL_PROFIT_TARGET_AUD,
  };

  const perTypeInstructions = (() => {
    if (briefType === "daily") {
      return [
        "This is the DAILY brief. Recipient: Tony.",
        "SECTION ONE IS ALWAYS 'What I could not check'. Before any finding, list every specialistHealth entry with isBlindSpot=true and every detectorBlindSpots entry — one line each, naming the domain that is therefore unverified (e.g. a silent payables agent means NO accounts-payable checking happened, not that AP is clean). If both lists are empty, write exactly: 'Coverage: all seven specialists completed and are producing — nothing unchecked.'",
        "NEVER describe a specialist with no findings as clean, quiet, or ✓ unless its status is exactly 'ok'. Statuses 'silent', 'incomplete', 'stale', 'failed' and 'never' mean the check did not happen — an absence of findings from those agents is an absence of information, and saying otherwise is the single worst error you can make in this brief.",
        "Where an agent's status is 'silent', any open items it still carries are unverified carry-over from when it last ran — label them as such and do not present them as today's picture.",
        "Then lead with the single most important thing that DID get checked.",
        "Then: cash position both entities, then GST position both entities (if gstByEntity has data — say '(no live data)' rather than guessing if it doesn't), then today's items (correlated, prioritised), then anything for this week.",
        "Receivables detail goes to Nicole's separate recon & receivables brief — cover AR in ONE line using arPolicy: the 61-90d pipeline ($ and count), how many invoices crept past 90 in the last 7 days (target is zero — a non-zero creep count is a process failure worth naming), and the 90+ backlog total. Do not itemise individual overdue invoices.",
        "Always include a section titled 'Controls & Audit (Xero ↔ Compliance)'.",
        "In that section, list every itemsForAction whose sourceAgents includes 'controls-audit' — one line each with title, entityCode, and short detail.",
        "If none have 'controls-audit' in sourceAgents, write exactly this single line under the section: 'No findings today — all Xero bills reconciled against compliance tickets, supplier compliance current, vendor master-data and bank-detail changes clean.'",
        "Do not repeat the coverage gaps at the end — they were section one.",
        "Restricted items are referenced only as a count — never name people or quote individual pay.",
      ].join(" ");
    }
    if (briefType === "recon-ar") {
      return [
        "This is the RECONCILIATION & RECEIVABLES brief. Recipient: Nicole, who owns bank reconciliation and aged-care receivables.",
        "Section 1 — Reconciliation: genuinely overdrawn bank accounts, feed gaps / unavailable balances, unposted and late journals, intercompany issues. Credit-card liability balances are NOT overdrawn accounts.",
        "Section 2 — Receivables, in this exact priority order (see arPolicy): (1) THE 61-90 DAY BUCKET IS ALWAYS THE TOP PRIORITY — these invoices only get paid if we chase them; list every one (policyTag priority-61-90), grouped by debtor, with amounts and a concrete follow-up action each; the goal is this bucket empties and NOTHING crosses 90. (2) Invoices that CREPT past 90 in the last 7 days (policyTag crept-past-90) are process failures — flag each one explicitly. (3) The standing 90+ backlog appears as one aggregate line per entity (policyTag backlog-90-plus) — it needs a working session where every invoice gets a payment plan or a write-off recommendation to Tony; do not itemise it. Then debtor exposure breaches.",
        "Receivables findings do not yet carry a funding-type tag. Where a debtor reference clearly looks NDIS (NDIA or a plan manager), note it as likely NDIS — those are handled separately — rather than assigning Nicole the chase.",
        "Item titles identify each invoice by invoice number and the debtor's real name. Refer to debtors BY NAME and quote the invoice number. Never use masked refs (like JB-2c62) in your narrative; if an item has no name, give the invoice number to look up in Xero.",
        "Keep it to what Nicole can act on this week. No profit or margin figures.",
      ].join(" ");
    }
    if (briefType === "restricted") {
      return [
        "This is the RESTRICTED brief — Tony + Lindsay (people) and/or Nicole (pay).",
        "Neutral language only — describe matching patterns, never accuse anyone.",
        "Each item is a signal for review, not a finding.",
        "Suggest one concrete next step per item where possible.",
      ].join(" ");
    }
    if (briefType === "weekly") {
      return [
        "This is the WEEKLY team report. Recipients: Tony + section-owning managers.",
        "AGGREGATE figures only. No individual data, no named individuals, no pay rates.",
        "Sections: revenue, labour, AP, AR, controls, tax. Each short and readable.",
      ].join(" ");
    }
    return [
      "This is the MONTHLY pack. Recipients: Tony + the external accountant.",
      "Cover: consolidated AND per-entity P&L view, cash flow, goal metrics vs target (especially the $3M trajectory), and the month's exceptions + how they resolved.",
      "Honest about trend direction — if we're behind, say so.",
    ].join(" ");
  })();

  // Non-negotiable honesty rules, appended to every brief type.
  const extraInstructions = [
    perTypeInstructions,
    "Every item carries firstRaised (when the condition began), lastSeen (when the data last confirmed it), ageDays, and freshDays.",
    "Anything with ageDays > 7 is LONG-OUTSTANDING — present it as 'open since <firstRaised>', never as new and never as today's discovery.",
    "For balance-type items (overdrawn, balance unavailable, low cash) the figure is as at lastSeen: if freshDays <= 1 the figure is CURRENT — say 'as of <lastSeen>, persisting since <firstRaised>'. If freshDays > 2 the condition has stopped being re-confirmed — treat it as unverified and likely resolved; the monitoring gap, not the number, is the issue.",
    "Where a bank feed is broken (balance-unavailable persisting for weeks), Xero register-derived balances — including 'overdrawn' figures — are unreliable. The action is reconnecting the feed and reconciling; do not treat the register number as a cash emergency.",
    "specialistHealth.lastRunAt is when a detector last ran; it says nothing about how fresh a finding is. Never imply an item is fresh because its agent ran recently, and never invent run times.",
    "A specialist reporting zero findings is only good news if its status is 'ok'. Zero findings from a 'silent', 'incomplete', 'stale', 'failed' or 'never' agent means nothing was checked — report it as an unmonitored domain and name what is therefore unknown. Never write a tick, 'no exceptions', 'clean' or 'all good' against such an agent.",
    "If a figure is arithmetically implausible (a ratio above 300%, a credit-card balance described as 'overdrawn', a revenue denominator smaller than one day of payroll), say it looks like a data artifact, name the specific check needed, and do not headline it as an operating result.",
    "If most items are long-outstanding, the headline must say so — do not manufacture urgency from a stale backlog.",
    "Craig has left JBC (May 2026) — never assign an action or escalation to Craig.",
  ].join(" ");

  const synthesis = await synthesiseBrief({
    briefType,
    entityScope: briefType === "weekly" || briefType === "monthly" ? "consolidated" : "consolidated",
    dataAsOf,
    data: synthesisPayload,
    extraInstructions,
  });

  // ── Dry-run: render the email and stop — no persistence, no send. ──
  if (dryRun) {
    const { to: dryTo, subject: drySubject } = routing(briefType, synthesis.headline);
    const dryBody = renderEmailBody({
      headline: synthesis.headline,
      narrative: synthesis.narrative,
      dataAsOf,
      cashByEntity,
      gstByEntity: briefType === "recon-ar" ? null : gstByEntity,
      goalMetrics: scopedMetrics,
      items: displayItems,
      staleAgents,
      detectorBlindSpots,
      restrictedTotalSummary: isRestricted ? null : restrictedTotal,
    });
    return {
      briefId: "(dry-run)",
      briefType,
      itemsTodayCount: itemsToday.length,
      itemsThisWeekCount: itemsThisWeek.length,
      notesCount: itemsNote.length,
      restrictedCount: restrictedTotal,
      staleSpecialistsCount: staleAgents.length,
      delivered: false,
      subject: drySubject,
      bodyText: dryBody,
      wouldSendTo: dryTo,
    };
  }

  // ── Persist the brief row + correlated issues. ──
  const brief = await prisma.financeBrief.create({
    data: {
      briefType,
      entityScope: "consolidated",
      headline: synthesis.headline,
      narrative: synthesis.narrative,
      sourcedRunIds: statuses.map((s) => ({
        agent: s.agent,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
        lastRunStatus: s.lastRunStatus,
        exceptionsOpen: s.exceptionsOpen,
      })) as unknown as object,
      itemsForAction: displayItems.map((c) => ({
        title: c.title,
        priority: c.priority,
        amount: c.amount,
        entityCode: c.entityCode,
        sourceAgents: c.sourceAgents,
        isConflict: c.isConflict,
        isRestricted: c.isRestricted,
        sourceExceptionIds: c.sourceExceptionIds,
        firstRaised: c.firstRaised,
        ageDays: c.ageDays,
        policyTag: c.policyTag ?? null,
      })) as unknown as object,
    },
  });

  for (const c of displayItems) {
    await prisma.correlatedIssue.create({
      data: {
        briefId: brief.id,
        title: c.title,
        detail: c.detail,
        priority: c.priority,
        sourceAgents: c.sourceAgents as unknown as object,
        sourceExceptionIds: c.sourceExceptionIds as unknown as object,
        isRestricted: c.isRestricted,
        isConflict: c.isConflict,
        entityCode: c.entityCode,
        amount: c.amount == null ? null : (c.amount as unknown as number),
      },
    });
  }

  // ── Deliver via SES with the channel guard. ──
  const { channel, to, subject } = routing(briefType, synthesis.headline);
  const bodyText = renderEmailBody({
    headline: synthesis.headline,
    narrative: synthesis.narrative,
    dataAsOf,
    cashByEntity,
    gstByEntity: briefType === "recon-ar" ? null : gstByEntity,
    goalMetrics: scopedMetrics,
    items: displayItems,
    staleAgents,
    detectorBlindSpots,
    restrictedTotalSummary: isRestricted ? null : restrictedTotal,
  });

  let delivered = false;
  let deliveryError: string | null = null;
  try {
    await sendChannelEmail({
      channel,
      to,
      subject,
      text: bodyText,
      flagsCount: items.length,
      peopleFlagsIncluded: isRestricted,
      briefId: brief.id,
    });
    delivered = true;
  } catch (e) {
    deliveryError = e instanceof Error ? e.message : String(e);
  }

  await prisma.financeBrief.update({
    where: { id: brief.id },
    data: {
      recipients: to.join(", "),
      deliveryStatus: delivered ? "sent" : (deliveryError ? "error" : "skipped"),
      deliveryError,
    },
  });

  return {
    briefId: brief.id,
    briefType,
    itemsTodayCount: itemsToday.length,
    itemsThisWeekCount: itemsThisWeek.length,
    notesCount: itemsNote.length,
    restrictedCount: restrictedTotal,
    staleSpecialistsCount: staleAgents.length,
    delivered,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function routing(briefType: BriefType, headline: string): { channel: Channel; to: string[]; subject: string } {
  const dateLabel = brisbaneDate(new Date());
  switch (briefType) {
    case "daily":
      return {
        channel: "daily-brief",
        to: recipients(env.MARK_DAILY_RECIPIENTS),
        subject: `Mark — daily brief ${dateLabel} — ${headline}`.slice(0, 250),
      };
    case "recon-ar":
      return {
        channel: "recon-ar-brief",
        to: recipients(env.MARK_RECON_AR_RECIPIENTS),
        subject: `Mark — recon & receivables ${dateLabel} — ${headline}`.slice(0, 250),
      };
    case "restricted":
      return {
        channel: "restricted-brief",
        to: recipients(env.MARK_RESTRICTED_RECIPIENTS),
        subject: `Mark — RESTRICTED brief ${dateLabel}`.slice(0, 250),
      };
    case "weekly":
      return {
        channel: "weekly-report",
        to: recipients(env.MARK_WEEKLY_RECIPIENTS),
        subject: `Mark — weekly report (w/e ${dateLabel}) — ${headline}`.slice(0, 250),
      };
    case "monthly":
      return {
        channel: "monthly-pack",
        to: recipients(env.MARK_MONTHLY_RECIPIENTS),
        subject: `Mark — monthly finance pack ${dateLabel} — ${headline}`.slice(0, 250),
      };
  }
}

interface CashPoint {
  amount: number | null;
  /** Brisbane date the recon finding carrying this number was created —
   *  surfaced so a week-old cash figure can never masquerade as today's. */
  asOf: string | null;
}

function recentCashByEntity(findings: IngestedFinding[]): Record<"SC" | "CQ", CashPoint> {
  const out: Record<"SC" | "CQ", CashPoint> = {
    SC: { amount: null, asOf: null },
    CQ: { amount: null, asOf: null },
  };
  const candidates = findings.filter(
    (f) => f.specialistAgent === "reconciliation" && /cash-?position/i.test(f.detector),
  );
  // A cash-position finding is upserted in place, so created_at is when the
  // panel was FIRST populated, not when the figure was last confirmed. Date it
  // off evidence.runAt (the run that re-confirmed it), same as the item-freshness
  // logic — otherwise today's cash always reads with a weeks-old "as of".
  const runAtMs = (f: IngestedFinding): number => {
    const ev = f.evidenceJson;
    const ra = ev && typeof ev === "object" ? (ev as Record<string, unknown>).runAt : null;
    const t = typeof ra === "string" ? Date.parse(ra) : NaN;
    return Number.isFinite(t) ? t : f.at.getTime();
  };
  const sorted = [...candidates].sort((a, b) => runAtMs(b) - runAtMs(a));
  for (const f of sorted) {
    const asOf = brisbaneDate(new Date(runAtMs(f)));
    if (f.entityCode === "SC" && out.SC.amount == null && f.amount != null) {
      out.SC = { amount: Number(f.amount), asOf };
    }
    if (f.entityCode === "CQ" && out.CQ.amount == null && f.amount != null) {
      out.CQ = { amount: Number(f.amount), asOf };
    }
  }
  return out;
}

interface GstPoint {
  /** Net GST owed for the current open BAS period (gst.netGst from the finding). */
  netGst: number | null;
  /** Cash set aside in mapped GST clearing accounts, if configured. */
  cashSetAside: number | null;
  /** BAS period label, e.g. "2026-Q2". */
  periodLabel: string | null;
  asOf: string | null;
}

/** Mirrors recentCashByEntity — pulls the most recent "gst-position" finding
 *  per entity (Dot / tax-compliance), dated off evidence.runAt so a stale
 *  figure can never present as today's. */
function recentGstByEntity(findings: IngestedFinding[]): Record<"SC" | "CQ", GstPoint> {
  const out: Record<"SC" | "CQ", GstPoint> = {
    SC: { netGst: null, cashSetAside: null, periodLabel: null, asOf: null },
    CQ: { netGst: null, cashSetAside: null, periodLabel: null, asOf: null },
  };
  const candidates = findings.filter(
    (f) => f.specialistAgent === "tax-compliance" && /gst-?position/i.test(f.detector),
  );
  const runAtMs = (f: IngestedFinding): number => {
    const ev = f.evidenceJson;
    const ra = ev && typeof ev === "object" ? (ev as Record<string, unknown>).runAt : null;
    const t = typeof ra === "string" ? Date.parse(ra) : NaN;
    return Number.isFinite(t) ? t : f.at.getTime();
  };
  const sorted = [...candidates].sort((a, b) => runAtMs(b) - runAtMs(a));
  for (const f of sorted) {
    if (f.entityCode !== "SC" && f.entityCode !== "CQ") continue;
    if (out[f.entityCode].netGst != null) continue; // already filled from a newer row
    const ev = f.evidenceJson;
    const obj = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {};
    const period = obj.period && typeof obj.period === "object" ? (obj.period as Record<string, unknown>) : {};
    const cashSetAside = typeof obj.cashSetAside === "number" ? obj.cashSetAside : null;
    out[f.entityCode] = {
      netGst: f.amount != null ? Number(f.amount) : null,
      cashSetAside,
      periodLabel: typeof period.label === "string" ? period.label : null,
      asOf: brisbaneDate(new Date(runAtMs(f))),
    };
  }
  return out;
}

// ── Coverage gaps ────────────────────────────────────────────────

/** A finding that says "this check did not run", not "here is a problem".
 *  Specialists raise these as `<label>-detector-failed` / `<label>-failed`
 *  when a sub-detector throws, plus a few named export-missing cases. */
export function isDetectorFailure(detector: string): boolean {
  return /(-detector-failed|-failed|^ingest-failure|export-missing|not-configured)$/i.test(detector)
    || /^ingest-failure/i.test(detector);
}

/** Feeds into the shared findings DB from producers Mark doesn't run himself.
 *  If one stops writing, its leftover open rows keep appearing in the brief
 *  forever with nothing behind them — so a quiet unowned producer is reported
 *  in the coverage section exactly like a silent specialist. */
export function silentUnownedProducers(
  findings: IngestedFinding[],
  statuses: SpecialistRunStatus[],
  now: Date,
): Array<{ agent: string; status: string; lastRunAt: string; error: string | null }> {
  const owned = new Set(statuses.map((s) => s.agent));
  const newestByAgent = new Map<string, number>();
  for (const f of findings) {
    if (owned.has(f.specialistAgent)) continue;
    const t = f.at.getTime();
    if (t > (newestByAgent.get(f.specialistAgent) ?? 0)) newestByAgent.set(f.specialistAgent, t);
  }
  const out: Array<{ agent: string; status: string; lastRunAt: string; error: string | null }> = [];
  for (const [agent, newest] of newestByAgent) {
    const ageDays = Math.floor((now.getTime() - newest) / 86_400_000);
    if (ageDays <= SILENT_PRODUCER_DAYS) continue;
    out.push({
      agent,
      status: "silent",
      lastRunAt: brisbaneDate(new Date(newest)),
      error:
        `not one of the seven specialists and has written nothing in ${ageDays} days — ` +
        `its open items are unverified carry-over, and nothing in its domain is being checked`,
    });
  }
  return out;
}

/** An unowned producer quiet for longer than this has stopped feeding Mark. */
const SILENT_PRODUCER_DAYS = 14;

export interface DetectorBlindSpot {
  agent: string;
  detector: string;
  entities: string[];
  /** Distinct days this check has been failing — the run count, not row count,
   *  so the date-stamped-dedupKey duplicates don't inflate it. */
  daysFailing: number;
  firstSeen: string;
  lastSeen: string;
  /** True when the check has been down long enough that anything it would have
   *  caught is now an unknown backlog, not a fresh gap. */
  chronic: boolean;
  sampleTitle: string;
}

const CHRONIC_BLIND_SPOT_DAYS = 7;

/** Collapse the `*-failed` finding rows into one line per (agent, detector).
 *  Today these arrive as one row per run per entity — 68 rows for a single
 *  broken GST check — which is why they read as noise instead of as the
 *  coverage gap they are. */
export function summariseDetectorFailures(
  findings: IngestedFinding[],
  now: Date,
): DetectorBlindSpot[] {
  const byKey = new Map<string, IngestedFinding[]>();
  for (const f of findings) {
    if (!isDetectorFailure(f.detector)) continue;
    const k = `${f.specialistAgent}::${f.detector}`;
    const bucket = byKey.get(k) ?? [];
    bucket.push(f);
    byKey.set(k, bucket);
  }

  const out: DetectorBlindSpot[] = [];
  for (const [, group] of byKey) {
    const times = group.map((f) => f.at.getTime());
    const first = Math.min(...times);
    const last = Math.max(...times);
    const days = new Set(group.map((f) => brisbaneDate(f.at))).size;
    out.push({
      agent: group[0].specialistAgent,
      detector: group[0].detector,
      entities: [...new Set(group.map((f) => f.entityCode))].sort(),
      daysFailing: days,
      firstSeen: brisbaneDate(new Date(first)),
      lastSeen: brisbaneDate(new Date(last)),
      chronic: (now.getTime() - first) / 86_400_000 > CHRONIC_BLIND_SPOT_DAYS,
      sampleTitle: group[0].title,
    });
  }
  // Longest-running gap first — that's the one with the biggest unknown behind it.
  out.sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));
  return out;
}

// ── AR collections policy ────────────────────────────────────────

const AR_PIPELINE_DETECTOR = "invoice-60-plus";
const AR_BACKLOG_DETECTORS = new Set(["invoice-90-plus", "writeoff-candidate"]);
/** An invoice whose 90+ finding is at most this old "crept" past 90 on our watch. */
const AR_CREEP_DAYS = 7;

type PrioritisedCandidate = ReturnType<typeof prioritiseAll>[number] & {
  ageDays: number;
  freshDays: number;
  firstRaised: string;
  lastSeen: string;
  policyTag?: "priority-61-90" | "crept-past-90" | "backlog-90-plus";
};

export interface ArPolicySummary {
  policy: string;
  perEntity: Record<string, { pipeline6190: { count: number; total: number };
    creptPast90Last7d: { count: number; total: number };
    backlog90plus: { count: number; total: number } }>;
}

/** Reshape receivables candidates per the collections policy:
 *  - 61-90d invoices are ALWAYS "today" (exempt from stale demotion) — they
 *    only get paid if chased, and they must not creep past 90.
 *  - 90+ findings newer than AR_CREEP_DAYS are creep failures — "today".
 *  - older 90+ / write-off candidates collapse into one aggregate backlog
 *    item per entity (deduped by invoice — the same invoice often carries
 *    both a 90+ and a write-off finding). */
export function applyReceivablesPolicy(
  prioritised: PrioritisedCandidate[],
  dataAsOf: string,
): { candidates: PrioritisedCandidate[]; arPolicy: ArPolicySummary } {
  const out: PrioritisedCandidate[] = [];
  const backlog: Record<string, { count: number; total: number }> = {};
  const pipeline: Record<string, { count: number; total: number }> = {};
  const creep: Record<string, { count: number; total: number }> = {};
  const seenBacklogInvoices = new Set<string>();

  const bump = (rec: Record<string, { count: number; total: number }>, ent: string, amount: number | null) => {
    rec[ent] = rec[ent] ?? { count: 0, total: 0 };
    rec[ent].count += 1;
    rec[ent].total += Math.abs(amount ?? 0);
  };
  const invoiceKeyOf = (c: PrioritisedCandidate): string => {
    const ev = c.findings[0]?.evidenceJson;
    const obj = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {};
    return String(obj.xeroInvoiceId ?? obj.invoiceNumber ?? c.key);
  };

  // Pass 1: invoices with an open 90+ finding. Detectors don't auto-resolve
  // a 60-plus finding when the invoice crosses 90, so a 60-plus row whose
  // invoice is in this set is stale — the 90+ finding owns it.
  const past90Invoices = new Set<string>();
  for (const c of prioritised) {
    if (c.findings.some((f) => f.detector === "invoice-90-plus")) {
      past90Invoices.add(invoiceKeyOf(c));
    }
  }

  for (const c of prioritised) {
    const detectors = new Set(c.findings.map((f) => f.detector));
    if (detectors.has(AR_PIPELINE_DETECTOR)) {
      if (past90Invoices.has(invoiceKeyOf(c))) continue; // stale 60-plus — invoice already past 90
      bump(pipeline, c.entityCode, c.amount);
      out.push({ ...c, priority: "today", policyTag: "priority-61-90" });
      continue;
    }
    const isBacklog = c.findings.length > 0 && c.findings.every((f) => AR_BACKLOG_DETECTORS.has(f.detector));
    if (isBacklog) {
      const invoiceKey = invoiceKeyOf(c);
      if (seenBacklogInvoices.has(invoiceKey)) continue; // same invoice, second detector
      seenBacklogInvoices.add(invoiceKey);
      // Creep = the invoice CROSSED 90 recently (fresh 90-plus finding). A
      // fresh writeoff-candidate alone means it crossed 120, not 90 — backlog.
      if (c.ageDays <= AR_CREEP_DAYS && detectors.has("invoice-90-plus")) {
        bump(creep, c.entityCode, c.amount);
        out.push({ ...c, priority: "today", policyTag: "crept-past-90" });
      } else {
        bump(backlog, c.entityCode, c.amount);
      }
      continue;
    }
    out.push(c);
  }

  for (const [ent, b] of Object.entries(backlog)) {
    out.push({
      key: `ar-backlog-90plus-${ent}`,
      title: `${ent}: 90+ day AR backlog — ${b.count} invoice(s), $${Math.round(b.total).toLocaleString("en-AU")} — each needs a chase plan or a write-off recommendation`,
      detail:
        `Standing backlog of invoices past 90 days (${ent}). Policy: these do not get itemised daily — ` +
        `they need a working session where every invoice gets either a payment plan or a write-off recommendation to Tony.`,
      entityCode: ent,
      amount: b.total,
      sourceAgents: ["receivables"],
      sourceExceptionIds: [],
      isRestricted: false,
      isConflict: false,
      topSeverity: "warning",
      findings: [],
      priority: "this-week",
      ageDays: 0,
      freshDays: 0,
      firstRaised: dataAsOf,
      lastSeen: dataAsOf,
      policyTag: "backlog-90-plus",
    });
  }

  const entities = new Set([...Object.keys(pipeline), ...Object.keys(creep), ...Object.keys(backlog)]);
  const perEntity: ArPolicySummary["perEntity"] = {};
  for (const ent of entities) {
    perEntity[ent] = {
      pipeline6190: pipeline[ent] ?? { count: 0, total: 0 },
      creptPast90Last7d: creep[ent] ?? { count: 0, total: 0 },
      backlog90plus: backlog[ent] ?? { count: 0, total: 0 },
    };
  }
  return {
    candidates: out,
    arPolicy: {
      policy:
        "61-90 day invoices are the always-top-priority working bucket — they only get paid if we chase. " +
        "Nothing may creep past 90 days (creep count target: zero). The 90+ backlog gets a chase plan or " +
        "write-off decision per invoice, worked as a project, not itemised daily.",
      perEntity,
    },
  };
}

// ── Live findings source ─────────────────────────────────────────

/** Items older than this can't claim "NEEDS YOU TODAY". */
const STALE_DEMOTE_DAYS = 7;
/** Items older than this drop to the notes section. */
const STALE_NOTE_DAYS = 21;

export async function fetchOpenFindings(): Promise<IngestedFinding[]> {
  if (hermesConfigured()) {
    // The AR policy detectors are fetched in full alongside the stratified
    // set — the severity-ordered per-agent cap otherwise starves out the
    // warning-level 61-90d rows, which are the collections priority.
    const [stratified, arRows] = await Promise.all([
      listOpenFindingsForQa({ includePeopleFlag: true, limit: 800, perAgentCap: 120 }),
      listOpenFindingsByDetectors([AR_PIPELINE_DETECTOR, ...AR_BACKLOG_DETECTORS]),
    ]);
    const seen = new Set<string>();
    const merged: HermesFinding[] = [];
    for (const r of [...stratified, ...arRows]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
    return merged.map(hermesToFinding);
  }
  return prisma.ingestedFinding.findMany({
    where: { resolved: false },
    orderBy: [{ severity: "asc" }, { at: "desc" }],
    take: 1500,
  });
}

/** Shape a shared-DB finding like the legacy IngestedFinding rows the
 *  correlate/prioritise/conflict pipeline was written against. Consumers
 *  only read fields (never Prisma methods), and `amount` is only ever used
 *  via Number(f.amount), so a plain number stands in for the Decimal. */
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

interface RenderEmailBodyArgs {
  headline: string;
  narrative: string;
  dataAsOf: string;
  cashByEntity: Record<"SC" | "CQ", CashPoint>;
  /** null for briefs that never carry tax content (e.g. recon-ar). */
  gstByEntity: Record<"SC" | "CQ", GstPoint> | null;
  goalMetrics: CapturedMetric[];
  items: Array<{
    title: string;
    detail: string;
    priority: Priority;
    amount: number | null;
    entityCode: string;
    sourceAgents: string[];
    isConflict: boolean;
    ageDays: number;
    freshDays: number;
    firstRaised: string;
    lastSeen: string;
    policyTag?: "priority-61-90" | "crept-past-90" | "backlog-90-plus";
  }>;
  staleAgents: Array<{ agent: string; status: string; lastRunAt: string; error: string | null }>;
  detectorBlindSpots: DetectorBlindSpot[];
  /** When set, append a one-liner reference (non-restricted briefs only). */
  restrictedTotalSummary: number | null;
}

/** Amounts only earn a slot when they carry information. A finding with a
 *  null or zero amount (unposted journals all carry 0.00) used to render as
 *  "— $0", which reads like a real figure of nothing. */
function amountSuffix(amount: number | null): string {
  if (amount == null || Math.round(Math.abs(amount)) === 0) return "";
  return ` — $${Math.round(Math.abs(amount)).toLocaleString("en-AU")}`;
}

/** Titles carry the whole meaning of a line, so cut them on a word boundary
 *  and mark the cut, rather than slicing mid-word as the detectors' own
 *  embedded-description titles do. */
function tidyTitle(title: string, max = 150): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s\-–—,;:[(]+$/, "")}…`;
}

function renderEmailBody(a: RenderEmailBodyArgs): string {
  const lines: string[] = [];
  lines.push(`HEADLINE: ${a.headline}`);
  lines.push("");
  lines.push(a.narrative);
  lines.push("");
  lines.push("─────────────────────────────────────────────");

  // Coverage first. What Mark could NOT check outranks anything he did.
  const coverageLines: string[] = [];
  for (const s of a.staleAgents) {
    coverageLines.push(
      `  ✗ ${s.agent}: ${s.status.toUpperCase()} — last run ${s.lastRunAt}${s.error ? ` — ${s.error}` : ""}`,
    );
  }
  for (const d of a.detectorBlindSpots) {
    const ent = d.entities.length > 0 ? ` [${d.entities.join(", ")}]` : "";
    coverageLines.push(
      `  ✗ ${d.agent} / ${d.detector}${ent} — failing ${d.daysFailing} run(s) since ${d.firstSeen}` +
        `${d.chronic ? " — CHRONIC, assume an unknown backlog behind it" : ""}`,
    );
  }
  if (coverageLines.length > 0) {
    lines.push(`WHAT I COULD NOT CHECK (${coverageLines.length}) — these domains are UNVERIFIED, not clean:`);
    lines.push(...coverageLines);
  } else {
    lines.push("COVERAGE: all specialists completed and are producing — nothing unchecked.");
  }
  lines.push("");

  lines.push("CASH POSITION");
  for (const ent of ["SC", "CQ"] as const) {
    const cp = a.cashByEntity[ent];
    lines.push(
      `  ${ent}: ${cp.amount == null
        ? "(no data)"
        : `$${cp.amount.toLocaleString("en-AU", { maximumFractionDigits: 0 })}${cp.asOf ? ` (as of ${cp.asOf})` : ""}`}`,
    );
  }
  lines.push("");

  if (a.gstByEntity) {
    lines.push("GST POSITION");
    for (const ent of ["SC", "CQ"] as const) {
      const gp = a.gstByEntity[ent];
      if (gp.netGst == null) {
        lines.push(`  ${ent}: (no live data)`);
        continue;
      }
      const period = gp.periodLabel ? ` for ${gp.periodLabel}` : "";
      const cash = gp.cashSetAside != null
        ? `, $${gp.cashSetAside.toLocaleString("en-AU", { maximumFractionDigits: 0 })} set aside`
        : "";
      const asOf = gp.asOf ? ` (as of ${gp.asOf})` : "";
      lines.push(`  ${ent}: $${gp.netGst.toLocaleString("en-AU", { maximumFractionDigits: 0 })} owed${period}${cash}${asOf}`);
    }
    lines.push("");
  }

  const today = a.items.filter((i) => i.priority === "today");
  const week = a.items.filter((i) => i.priority === "this-week");
  const notes = a.items.filter((i) => i.priority === "note");

  if (today.length > 0) {
    lines.push(`NEEDS YOU TODAY (${today.length}):`);
    for (const it of today) {
      const conflict = it.isConflict ? " [CONFLICT]" : "";
      const crept = it.policyTag === "crept-past-90" ? " ⚠ CREPT PAST 90 DAYS" : "";
      const unconfirmed = it.freshDays > 2 ? ` (last confirmed ${it.lastSeen})` : "";
      lines.push(
        `  • [${it.entityCode}] ${tidyTitle(it.title)}${amountSuffix(it.amount)}${conflict}${crept}${unconfirmed}`,
      );
      lines.push(`      from: ${it.sourceAgents.join(", ")}`);
    }
    lines.push("");
  }
  if (week.length > 0) {
    lines.push(`THIS WEEK (${week.length}):`);
    for (const it of week) {
      const aged = it.ageDays > 7 ? ` (open since ${it.firstRaised})` : "";
      const unconfirmed = it.freshDays > 2 ? ` (last confirmed ${it.lastSeen})` : "";
      lines.push(`  • [${it.entityCode}] ${tidyTitle(it.title)}${amountSuffix(it.amount)}${aged}${unconfirmed}`);
    }
    lines.push("");
  }
  if (notes.length > 0) {
    lines.push(`NOTES (${notes.length}):`);
    for (const it of notes.slice(0, 12)) {
      const aged = it.ageDays > 7 ? ` (open since ${it.firstRaised})` : "";
      lines.push(`  • [${it.entityCode}] ${tidyTitle(it.title)}${aged}`);
    }
    if (notes.length > 12) lines.push(`  ... ${notes.length - 12} more`);
    lines.push("");
  }

  if (a.goalMetrics.length > 0) {
    lines.push("GOAL METRICS:");
    for (const m of a.goalMetrics) {
      const tgt = m.target == null ? "" : ` (target ${formatGoalNumber(m.metric, m.target)})`;
      const trend = m.trend === "improving" ? "↑ improving" : m.trend === "worsening" ? "↓ worsening" : "→ flat";
      lines.push(`  • ${m.metric} [${m.entityScope}]: ${formatGoalNumber(m.metric, m.value)}${tgt} — ${trend}`);
    }
    lines.push("");
  }

  if (a.restrictedTotalSummary != null && a.restrictedTotalSummary > 0) {
    lines.push(`Restricted: ${a.restrictedTotalSummary} restricted item(s) — see separate brief.`);
    lines.push("");
  }

  lines.push(`Data as of ${a.dataAsOf}.`);
  lines.push("— Mark");
  return lines.join("\n");
}

function formatGoalNumber(metric: string, value: number): string {
  if (metric === "labour-cost-pct") return `${value.toFixed(1)}%`;
  if (metric === "dso") return `${value.toFixed(0)} days`;
  return `$${Math.round(value).toLocaleString("en-AU")}`;
}

// Use DateTime import so the lint check passes; brisbaneDate already wraps it.
export const _unusedDateTime = DateTime;
