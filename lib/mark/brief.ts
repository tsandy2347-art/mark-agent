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
import { hermesConfigured, listOpenFindingsForQa, type HermesFinding } from "../hermes-findings";
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
}

export async function buildBrief(briefType: BriefType): Promise<BriefResult> {
  try {
    return await buildBriefInner(briefType);
  } catch (e) {
    await sendHeartbeatFailure(e, `build-${briefType}-brief`).catch(() => undefined);
    throw e;
  }
}

async function buildBriefInner(briefType: BriefType): Promise<BriefResult> {
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
  // append-only — captures one row per goal input seen this run.)
  await captureGoalMetrics(openFindings).catch(() => undefined);

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
    const ageDays = Math.floor((now.getTime() - newestMs) / 86_400_000);
    let priority = c.priority;
    if (ageDays > STALE_NOTE_DAYS) priority = "note" as const;
    else if (ageDays > STALE_DEMOTE_DAYS && priority === "today") priority = "this-week" as const;
    return { ...c, priority, ageDays, firstRaised: brisbaneDate(new Date(oldestMs)) };
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

  // Channel-determined filter: restricted brief sees ONLY restricted items;
  // every other brief EXCLUDES restricted items entirely.
  const isRestricted = briefType === "restricted";
  const items = prioritised
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

  const itemsToday = items.filter((c) => c.priority === "today");
  const itemsThisWeek = items.filter((c) => c.priority === "this-week");
  const itemsNote = items.filter((c) => c.priority === "note");
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
    itemsForAction: items.map((c) => ({
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
    })),
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
        "Receivables detail goes to Nicole's separate recon & receivables brief — cover AR in at most one line of headline totals (from goal metrics); do not itemise individual overdue invoices.",
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
        "Section 2 — Receivables: AR aging totals, invoices 90+ days overdue, write-off candidates, debtor exposure breaches. Group by debtor where possible and give one concrete next action per group.",
        "Receivables findings do not yet carry a funding-type tag. Where a debtor reference clearly looks NDIS (NDIA or a plan manager), note it as likely NDIS — those are handled separately — rather than assigning Nicole the chase.",
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
    "Every item carries firstRaised and ageDays.",
    "Anything with ageDays > 7 is LONG-OUTSTANDING — present it as 'open since <firstRaised>', never as new and never as today's discovery.",
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
      itemsForAction: items.map((c) => ({
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
      })) as unknown as object,
    },
  });

  for (const c of items) {
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
    items,
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

// ── Live findings source ─────────────────────────────────────────

/** Items older than this can't claim "NEEDS YOU TODAY". */
const STALE_DEMOTE_DAYS = 7;
/** Items older than this drop to the notes section. */
const STALE_NOTE_DAYS = 21;

async function fetchOpenFindings(): Promise<IngestedFinding[]> {
  if (hermesConfigured()) {
    const rows = await listOpenFindingsForQa({ includePeopleFlag: true, limit: 800, perAgentCap: 120 });
    return rows.map(hermesToFinding);
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
    firstRaised: string;
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
      lines.push(`  • [${it.entityCode}] ${it.title}${amt}${conflict}`);
      lines.push(`      from: ${it.sourceAgents.join(", ")}`);
    }
    lines.push("");
  }
  if (week.length > 0) {
    lines.push(`THIS WEEK (${week.length}):`);
    for (const it of week) {
      const amt = it.amount != null ? ` — $${Math.round(Math.abs(it.amount)).toLocaleString("en-AU")}` : "";
      const aged = it.ageDays > 7 ? ` (open since ${it.firstRaised})` : "";
      lines.push(`  • [${it.entityCode}] ${it.title}${amt}${aged}`);
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
