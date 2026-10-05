// What happens when a recipient taps a button on the /f/<token> page.
// Kept apart from dismiss.ts, which the brief imports — this side writes.

import type { CorrelatedIssue } from "../generated/prisma";
import { prisma } from "../prisma";
import {
  getFindingsByIds,
  hermesConfigured,
  reopenFindingsClosedByBrief,
  resolveFindingsByHuman,
  type HermesFinding,
} from "../hermes-findings";
import {
  LINK_TTL_DAYS,
  SNOOZE_DAYS,
  VETTING_DETECTORS,
  findingIdentity,
  supplierDisplayName,
  vettingSupplierKey,
  type DismissAction,
} from "./dismiss";

export interface DismissView {
  issue: CorrelatedIssue;
  findings: HermesFinding[];
  expired: boolean;
  /** The supplier "not a care supplier" would silence, when offered. */
  vettingSupplier: string | null;
  /** The live answer for this line, if one was given. */
  answered: { action: string; until: Date | null; at: Date } | null;
}

function asIngested(f: HermesFinding) {
  return {
    evidenceJson: f.evidence as never,
    specialistAgent: f.sourceAgent,
    entityCode: f.entityCode,
    title: f.title,
    detector: f.detector,
  };
}

function findingIdsOf(issue: CorrelatedIssue): string[] {
  const raw = issue.sourceExceptionIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>).findingId : null))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

export async function loadDismissView(issueId: string): Promise<DismissView | null> {
  const issue = await prisma.correlatedIssue.findUnique({ where: { id: issueId } });
  // Restricted lines never get links; refuse them here too in case one leaks.
  if (!issue || issue.isRestricted) return null;
  const findings = hermesConfigured() ? await getFindingsByIds(findingIdsOf(issue)) : [];
  const expired = Date.now() - issue.createdAt.getTime() > LINK_TTL_DAYS * 86_400_000;
  const supplierFinding = findings.find((f) => vettingSupplierKey(asIngested(f)) != null);
  const latest = await prisma.findingSuppression.findFirst({
    where: { issueId, OR: [{ until: null }, { until: { gt: new Date() } }] },
    orderBy: { createdAt: "desc" },
  });
  return {
    issue,
    findings,
    expired,
    vettingSupplier: supplierFinding ? supplierDisplayName(asIngested(supplierFinding)) : null,
    answered: latest ? { action: latest.action, until: latest.until, at: latest.createdAt } : null,
  };
}

export async function applyDismiss(
  issueId: string,
  action: DismissAction | "undo",
  note: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const view = await loadDismissView(issueId);
  if (!view) return { ok: false, reason: "This item no longer exists." };
  if (view.expired) return { ok: false, reason: `This link is more than ${LINK_TTL_DAYS} days old.` };
  const { issue, findings } = view;
  const ids = findings.map((f) => f.id);
  const cleanNote = note?.trim().slice(0, 500) || null;

  if (action === "undo") {
    await prisma.findingSuppression.deleteMany({ where: { issueId } });
    await reopenFindingsClosedByBrief(ids);
    await prisma.correlatedIssue.update({
      where: { id: issueId },
      data: { resolved: false, resolvedAt: null, resolvedBy: null },
    });
    return { ok: true };
  }

  if (findings.length === 0) return { ok: false, reason: "Couldn't find the underlying findings." };

  const until = action === "snooze" ? new Date(Date.now() + SNOOZE_DAYS * 86_400_000) : null;
  const base = {
    action,
    entityCode: issue.entityCode,
    title: issue.title.slice(0, 500),
    findingIds: ids,
    issueId,
    until,
    note: cleanNote,
  };

  if (action === "not-care-supplier") {
    const byKey = new Map<string, HermesFinding>();
    for (const f of findings) {
      const key = vettingSupplierKey(asIngested(f));
      if (key) byKey.set(`${f.entityCode}|${key}`, f);
    }
    if (byKey.size === 0) return { ok: false, reason: "This item isn't a supplier-vetting check." };
    for (const [k, f] of byKey) {
      await prisma.findingSuppression.create({
        data: {
          ...base,
          scope: "supplier",
          entityCode: f.entityCode,
          supplierKey: k.split("|")[1],
          detectors: [...VETTING_DETECTORS],
        },
      });
    }
    await resolveFindingsByHuman({
      ids: findings.filter((f) => vettingSupplierKey(asIngested(f)) != null).map((f) => f.id),
      action: "wrong",
      note: `Not a care supplier — never vet (brief link)${cleanNote ? `: ${cleanNote}` : ""}`,
    });
  } else {
    for (const f of findings) {
      await prisma.findingSuppression.create({
        data: { ...base, scope: "finding", entityCode: f.entityCode, identity: findingIdentity(asIngested(f)) },
      });
    }
    if (action === "done" || action === "wrong") {
      await resolveFindingsByHuman({
        ids,
        action,
        note: `${action === "done" ? "Dealt with" : "Not a real problem"} (brief link)${cleanNote ? `: ${cleanNote}` : ""}`,
      });
    }
  }

  if (action !== "snooze") {
    await prisma.correlatedIssue.update({
      where: { id: issueId },
      data: { resolved: true, resolvedAt: new Date(), resolvedBy: `brief:${action}` },
    });
  }
  return { ok: true };
}
