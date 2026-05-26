// Function F — performance + goal tracking.
//
// Mark does not produce raw revenue / labour / DSO / GST figures himself. The
// specialists do that work and emit "goal-input" findings: low-severity rows
// whose detector starts with "goal:" and whose amount field carries the
// number. Reading those rows here lets the headline ($3M trajectory) be
// honest about what the team is actually seeing.
//
// If the goal inputs are not yet emitted by the specialists, Mark falls back
// to the most recent GoalMetric capture and surfaces "data is stale" rather
// than inventing a number.

import { DateTime } from "luxon";
import { prisma } from "../prisma";
import { env } from "../env";
import type { IngestedFinding } from "../generated/prisma";

export type Metric =
  | "profit-run-rate"
  | "labour-cost-pct"
  | "dso"
  | "unclaimed-revenue"
  | "net-gst";

export interface CapturedMetric {
  metric: Metric;
  entityScope: string;
  periodLabel: string;
  value: number;
  target: number | null;
  trend: "improving" | "flat" | "worsening";
}

interface GoalInput {
  metric: Metric;
  entityScope: string;
  value: number;
}

export async function captureGoalMetrics(findings: IngestedFinding[]): Promise<CapturedMetric[]> {
  const inputs = extractGoalInputs(findings);
  const periodLabel = DateTime.now().setZone("Australia/Brisbane").toFormat("yyyy-MM");
  const captured: CapturedMetric[] = [];

  for (const inp of inputs) {
    const target = targetFor(inp.metric, inp.entityScope);
    const trend = await computeTrend(inp.metric, inp.entityScope, inp.value);
    const row = {
      metric: inp.metric,
      entityScope: inp.entityScope,
      periodLabel,
      value: inp.value,
      target,
      trend,
    };
    await prisma.goalMetric.create({
      data: {
        metric: row.metric,
        entityScope: row.entityScope,
        periodLabel: row.periodLabel,
        value: row.value as unknown as number,
        target: row.target == null ? null : (row.target as unknown as number),
        trend: row.trend,
      },
    });
    captured.push(row);
  }
  return captured;
}

/** Read the most recent captured value per (metric, entityScope) — used by
 *  brief.ts to render the "where we stand" block without re-capturing. */
export async function readLatestMetrics(): Promise<CapturedMetric[]> {
  const all = await prisma.goalMetric.findMany({
    orderBy: { capturedAt: "desc" },
    take: 200,
  });
  const seen = new Set<string>();
  const out: CapturedMetric[] = [];
  for (const r of all) {
    const k = `${r.metric}@${r.entityScope}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      metric: r.metric as Metric,
      entityScope: r.entityScope,
      periodLabel: r.periodLabel,
      value: Number(r.value),
      target: r.target == null ? null : Number(r.target),
      trend: r.trend as CapturedMetric["trend"],
    });
  }
  return out;
}

function extractGoalInputs(findings: IngestedFinding[]): GoalInput[] {
  const out: GoalInput[] = [];
  for (const f of findings) {
    if (!f.detector?.startsWith("goal:")) continue;
    if (f.amount == null) continue;
    const metric = f.detector.replace(/^goal:/, "").trim() as Metric;
    if (!isMetric(metric)) continue;
    out.push({
      metric,
      entityScope: f.entityCode || "consolidated",
      value: Number(f.amount),
    });
  }
  return out;
}

function isMetric(s: string): s is Metric {
  return (
    s === "profit-run-rate" ||
    s === "labour-cost-pct" ||
    s === "dso" ||
    s === "unclaimed-revenue" ||
    s === "net-gst"
  );
}

function targetFor(metric: Metric, entityScope: string): number | null {
  switch (metric) {
    case "profit-run-rate":
      return env.GOAL_PROFIT_TARGET_AUD;
    case "labour-cost-pct":
      if (entityScope === "SC") return env.GOAL_LABOUR_COST_TARGET_PCT_SC;
      if (entityScope === "CQ") return env.GOAL_LABOUR_COST_TARGET_PCT_CQ;
      return null;
    case "dso":
      return env.GOAL_DSO_TARGET_DAYS;
    default:
      return null;
  }
}

async function computeTrend(metric: Metric, entityScope: string, value: number): Promise<CapturedMetric["trend"]> {
  const prior = await prisma.goalMetric.findFirst({
    where: { metric, entityScope },
    orderBy: { capturedAt: "desc" },
  });
  if (!prior) return "flat";
  const prev = Number(prior.value);
  if (!Number.isFinite(prev) || prev === 0) return "flat";
  const delta = value - prev;
  const pct = Math.abs(delta) / Math.abs(prev);
  if (pct < 0.01) return "flat";
  // For DSO and labour-cost-pct, higher is worse. For profit-run-rate, higher
  // is better. For unclaimed-revenue, higher is worse. For net-gst (amount
  // owed), higher is worse.
  const higherIsWorse = metric === "dso" || metric === "labour-cost-pct" || metric === "unclaimed-revenue" || metric === "net-gst";
  if (higherIsWorse) return delta > 0 ? "worsening" : "improving";
  return delta > 0 ? "improving" : "worsening";
}
