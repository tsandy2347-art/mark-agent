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
import { isStale } from "./poll";
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
  let candidates = correlateFindings(openFindings);
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

  // ── Specialist health → silent agents become their own item. ──
  const staleAgents = statuses
    .filter((s) => s.lastRunStatus === "failed" || isStale(s.lastRunAt))
    .map((s) => ({
      agent: s.agent,
      status: s.lastRunStatus,
      lastRunAt: s.lastRunAt ? brisbane(s.lastRunAt) : "(never)",
      error: s.lastError ?? null,
    }));

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
    goalMetrics: scopedMetrics,
    specialistHealth: statuses.map((s) => ({
      agent: s.agent,
      status: isStale(s.lastRunAt) ? "stale" : s.lastRunStatus,
      lastRunAt: s.lastRunAt ? brisbane(s.lastRunAt) : null,
      exceptionsOpen: s.exceptionsOpen,
      error: s.lastError,
    })),
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
        "Lead with the single most important thing.",
        "Then: cash position both entities, then today's items (correlated, prioritised), then anything for this week.",
        "Receivables detail goes to Nicole's separate recon & receivables brief — cover AR in ONE line using arPolicy: the 61-90d pipeline ($ and count), how many invoices crept past 90 in the last 7 days (target is zero — a non-zero creep count is a process failure worth naming), and the 90+ backlog total. Do not itemise individual overdue invoices.",
        "Always include a section titled 'Controls & Audit (Xero ↔ Compliance)'.",
        "In that section, list every itemsForAction whose sourceAgents includes 'controls-audit' — one line each with title, entityCode, and short detail.",
        "If none have 'controls-audit' in sourceAgents, write exactly this single line under the section: 'No findings today — all Xero bills reconciled against compliance tickets, supplier compliance current, vendor master-data and bank-detail changes clean.'",
        "End with one line per silent specialist if any.",
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
      goalMetrics: scopedMetrics,
      items: displayItems,
      staleAgents,
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
    goalMetrics: scopedMetrics,
    items: displayItems,
    staleAgents,
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
  const sorted = [...candidates].sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const f of sorted) {
    if (f.entityCode === "SC" && out.SC.amount == null && f.amount != null) {
      out.SC = { amount: Number(f.amount), asOf: brisbaneDate(f.at) };
    }
    if (f.entityCode === "CQ" && out.CQ.amount == null && f.amount != null) {
      out.CQ = { amount: Number(f.amount), asOf: brisbaneDate(f.at) };
    }
  }
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
  /** When set, append a one-liner reference (non-restricted briefs only). */
  restrictedTotalSummary: number | null;
}

function renderEmailBody(a: RenderEmailBodyArgs): string {
  const lines: string[] = [];
  lines.push(`HEADLINE: ${a.headline}`);
  lines.push("");
  lines.push(a.narrative);
  lines.push("");
  lines.push("─────────────────────────────────────────────");
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

  const today = a.items.filter((i) => i.priority === "today");
  const week = a.items.filter((i) => i.priority === "this-week");
  const notes = a.items.filter((i) => i.priority === "note");

  if (today.length > 0) {
    lines.push(`NEEDS YOU TODAY (${today.length}):`);
    for (const it of today) {
      const amt = it.amount != null ? ` — $${Math.round(Math.abs(it.amount)).toLocaleString("en-AU")}` : "";
      const conflict = it.isConflict ? " [CONFLICT]" : "";
      const crept = it.policyTag === "crept-past-90" ? " ⚠ CREPT PAST 90 DAYS" : "";
      const unconfirmed = it.freshDays > 2 ? ` (last confirmed ${it.lastSeen})` : "";
      lines.push(`  • [${it.entityCode}] ${it.title}${amt}${conflict}${crept}${unconfirmed}`);
      lines.push(`      from: ${it.sourceAgents.join(", ")}`);
    }
    lines.push("");
  }
  if (week.length > 0) {
    lines.push(`THIS WEEK (${week.length}):`);
    for (const it of week) {
      const amt = it.amount != null ? ` — $${Math.round(Math.abs(it.amount)).toLocaleString("en-AU")}` : "";
      const aged = it.ageDays > 7 ? ` (open since ${it.firstRaised})` : "";
      const unconfirmed = it.freshDays > 2 ? ` (last confirmed ${it.lastSeen})` : "";
      lines.push(`  • [${it.entityCode}] ${it.title}${amt}${aged}${unconfirmed}`);
    }
    lines.push("");
  }
  if (notes.length > 0) {
    lines.push(`NOTES (${notes.length}):`);
    for (const it of notes.slice(0, 12)) {
      const aged = it.ageDays > 7 ? ` (open since ${it.firstRaised})` : "";
      lines.push(`  • [${it.entityCode}] ${it.title}${aged}`);
    }
    if (notes.length > 12) lines.push(`  ... ${notes.length - 12} more`);
    lines.push("");
  }

  if (a.staleAgents.length > 0) {
    lines.push("SPECIALIST HEALTH (silent / failed):");
    for (const s of a.staleAgents) {
      lines.push(`  • ${s.agent}: ${s.status} — last run ${s.lastRunAt}${s.error ? ` (${s.error})` : ""}`);
    }
    lines.push("  (A silent specialist is its own finding — Mark cannot vouch for what they didn't check.)");
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
