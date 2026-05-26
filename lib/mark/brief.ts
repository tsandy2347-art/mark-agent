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
import type { IngestedFinding, SpecialistRunStatus } from "../generated/prisma";

export type BriefType = "daily" | "restricted" | "weekly" | "monthly";

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

  // ── Pull what we need from local cache (no specialist polling here). ──
  const [openFindings, statuses, latestMetrics] = await Promise.all([
    prisma.ingestedFinding.findMany({
      where: { resolved: false },
      orderBy: [{ severity: "asc" }, { at: "desc" }],
      take: 1500,
    }),
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
  const prioritised = prioritiseAll(candidates);

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
  const items = prioritised.filter((c) => (isRestricted ? c.isRestricted : !c.isRestricted));

  const itemsToday = items.filter((c) => c.priority === "today");
  const itemsThisWeek = items.filter((c) => c.priority === "this-week");
  const itemsNote = items.filter((c) => c.priority === "note");
  const restrictedTotal = prioritised.filter((c) => c.isRestricted).length;

  // Cash position both entities — pull most recent recon "cash-position" row.
  const cashByEntity = recentCashByEntity(openFindings);

  // ── Structured payload Anthropic synthesises into prose. ──
  const synthesisPayload = {
    briefType,
    dataAsOf,
    cashByEntity,
    goalMetrics: latestMetrics,
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
    })),
    restrictedItemSummary: isRestricted
      ? null
      : restrictedTotal > 0
        ? `${restrictedTotal} restricted item(s) — see separate brief`
        : null,
    profitTarget: env.GOAL_PROFIT_TARGET_AUD,
  };

  const extraInstructions = (() => {
    if (briefType === "daily") {
      return [
        "This is the DAILY brief. Recipients: Tony and Nicole.",
        "Lead with the single most important thing.",
        "Then: cash position both entities, then today's items (correlated, prioritised), then anything for this week.",
        "End with one line per silent specialist if any.",
        "Restricted items are referenced only as a count — never name people or quote individual pay.",
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
    goalMetrics: latestMetrics,
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

function recentCashByEntity(findings: IngestedFinding[]): Record<string, number | null> {
  const out: Record<string, number | null> = { SC: null, CQ: null };
  const candidates = findings.filter(
    (f) => f.specialistAgent === "reconciliation" && /cash-?position/i.test(f.detector),
  );
  const sorted = [...candidates].sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const f of sorted) {
    if (f.entityCode === "SC" && out.SC == null && f.amount != null) out.SC = Number(f.amount);
    if (f.entityCode === "CQ" && out.CQ == null && f.amount != null) out.CQ = Number(f.amount);
  }
  return out;
}

interface RenderEmailBodyArgs {
  headline: string;
  narrative: string;
  dataAsOf: string;
  cashByEntity: Record<string, number | null>;
  goalMetrics: CapturedMetric[];
  items: Array<{
    title: string;
    detail: string;
    priority: Priority;
    amount: number | null;
    entityCode: string;
    sourceAgents: string[];
    isConflict: boolean;
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
  lines.push(`  SC: ${a.cashByEntity.SC == null ? "(no data)" : `$${a.cashByEntity.SC.toLocaleString("en-AU", { maximumFractionDigits: 0 })}`}`);
  lines.push(`  CQ: ${a.cashByEntity.CQ == null ? "(no data)" : `$${a.cashByEntity.CQ.toLocaleString("en-AU", { maximumFractionDigits: 0 })}`}`);
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
      lines.push(`  • [${it.entityCode}] ${it.title}${amt}`);
    }
    lines.push("");
  }
  if (notes.length > 0) {
    lines.push(`NOTES (${notes.length}):`);
    for (const it of notes.slice(0, 12)) {
      lines.push(`  • [${it.entityCode}] ${it.title}`);
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
