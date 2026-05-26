// Function A — orchestration. Mark pulls FinanceFinding lists from each
// specialist's /api/findings endpoint, upserts them into IngestedFinding, and
// updates SpecialistRunStatus.
//
// Read-mostly: this module only writes Mark's own orchestration tables. It
// never POSTs anything back to a specialist or to a source system.
//
// Fail-quiet: per-specialist errors do NOT throw out of pollSpecialist — they
// are recorded as lastRunStatus="failed" with lastError set, so the next brief
// surfaces the silence as its own item (spec: "a blind spot is a finding").

import { prisma } from "../prisma";
import { env, type SpecialistAgent, type SpecialistDescriptor, specialists } from "../env";
import type { FindingsEnvelope, FinanceFinding } from "../findings";
import { mockFindingsFor } from "./mock/fixtures";

export interface PollResult {
  agent: SpecialistAgent;
  ok: boolean;
  count: number;
  status: "ok" | "exceptions" | "failed" | "stale" | "never";
  error?: string;
}

const POLL_TIMEOUT_MS = 20_000;

export async function pollSpecialist(desc: SpecialistDescriptor): Promise<PollResult> {
  // Mock mode short-circuit — exercise the whole pipeline without any
  // specialist being up. See lib/mark/mock/fixtures.ts.
  if (env.MARK_MOCK) {
    const findings = mockFindingsFor(desc.agent);
    await upsertFindings(desc.agent, findings);
    const open = findings.filter((f) => !f.resolved).length;
    const status: PollResult["status"] = open > 0 ? "exceptions" : "ok";
    await persistStatus(desc.agent, { lastRunAt: new Date(), lastRunStatus: status, lastError: null, exceptionsOpen: open });
    return { agent: desc.agent, ok: true, count: findings.length, status };
  }

  if (!desc.url) {
    const err = `no SPECIALIST_${desc.agent.replace(/-/g, "_").toUpperCase()}_URL configured`;
    await persistStatus(desc.agent, { lastRunStatus: "failed", lastError: err });
    return { agent: desc.agent, ok: false, count: 0, status: "failed", error: err };
  }

  if (!env.HUB_API_KEY) {
    const err = "HUB_API_KEY not set — cannot authenticate to specialist";
    await persistStatus(desc.agent, { lastRunStatus: "failed", lastError: err });
    return { agent: desc.agent, ok: false, count: 0, status: "failed", error: err };
  }

  const url = buildFindingsUrl(desc.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.HUB_API_KEY}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`;
      await persistStatus(desc.agent, { lastRunStatus: "failed", lastError: err });
      return { agent: desc.agent, ok: false, count: 0, status: "failed", error: err };
    }
    const json = (await res.json()) as Partial<FindingsEnvelope>;
    const findings = Array.isArray(json.findings) ? json.findings : [];
    await upsertFindings(desc.agent, findings);
    const open = findings.filter((f) => !f.resolved).length;
    const status: PollResult["status"] = open > 0 ? "exceptions" : "ok";
    await persistStatus(desc.agent, { lastRunAt: new Date(), lastRunStatus: status, lastError: null, exceptionsOpen: open });
    return { agent: desc.agent, ok: true, count: findings.length, status };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await persistStatus(desc.agent, { lastRunStatus: "failed", lastError: err });
    return { agent: desc.agent, ok: false, count: 0, status: "failed", error: err };
  } finally {
    clearTimeout(timer);
  }
}

function buildFindingsUrl(base: string): string {
  // Mark always asks for non-people, non-resolved by default. Restricted brief
  // assembly uses a separate poll path (pollSpecialistRestricted) if/when we
  // need it; v1 keeps it simple and pulls everything via include_people=1
  // when the caller is restricted-mode.
  const trimmed = base.replace(/\/+$/, "");
  // Mark wants people findings too — he is allowed to read them; the routing
  // guard at the email layer is what keeps them off non-restricted briefs.
  // Without include_people=1 he would never see them on poll.
  return `${trimmed}/api/findings?include_people=1`;
}

interface StatusUpdate {
  lastRunAt?: Date;
  lastRunStatus: string;
  lastError?: string | null;
  exceptionsOpen?: number;
}

async function persistStatus(agent: SpecialistAgent, update: StatusUpdate): Promise<void> {
  await prisma.specialistRunStatus.upsert({
    where: { agent },
    create: {
      agent,
      lastRunAt: update.lastRunAt ?? null,
      lastRunStatus: update.lastRunStatus,
      lastError: update.lastError ?? null,
      exceptionsOpen: update.exceptionsOpen ?? 0,
    },
    update: {
      ...(update.lastRunAt ? { lastRunAt: update.lastRunAt } : {}),
      lastRunStatus: update.lastRunStatus,
      lastError: update.lastError === undefined ? undefined : update.lastError,
      ...(update.exceptionsOpen !== undefined ? { exceptionsOpen: update.exceptionsOpen } : {}),
    },
  });
}

async function upsertFindings(agent: SpecialistAgent, findings: FinanceFinding[]): Promise<void> {
  for (const f of findings) {
    if (!f.id) continue;
    const at = parseAt(f.at);
    await prisma.ingestedFinding.upsert({
      where: {
        specialistAgent_specialistFindingId: {
          specialistAgent: agent,
          specialistFindingId: f.id,
        },
      },
      create: {
        specialistAgent: agent,
        specialistFindingId: f.id,
        at,
        severity: f.severity,
        isPeopleFlag: Boolean(f.isPeopleFlag),
        entityCode: f.entityCode || "BOTH",
        domain: f.domain || "",
        detector: f.detector || "",
        title: f.title || "(no title)",
        body: f.body || "",
        explanation: f.explanation ?? null,
        evidenceJson: (f.evidence ?? {}) as unknown as object,
        amount: f.amount == null ? null : (f.amount as unknown as number),
        suggestedAction: String(f.suggestedAction ?? "review"),
        resolved: Boolean(f.resolved),
      },
      update: {
        // Resolution + severity may change upstream; sync them.
        at,
        severity: f.severity,
        isPeopleFlag: Boolean(f.isPeopleFlag),
        entityCode: f.entityCode || "BOTH",
        domain: f.domain || "",
        detector: f.detector || "",
        title: f.title || "(no title)",
        body: f.body || "",
        explanation: f.explanation ?? null,
        evidenceJson: (f.evidence ?? {}) as unknown as object,
        amount: f.amount == null ? null : (f.amount as unknown as number),
        suggestedAction: String(f.suggestedAction ?? "review"),
        resolved: Boolean(f.resolved),
      },
    });
  }
}

function parseAt(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

/** Helper used by the daily brief — agents whose lastRunAt is older than
 *  MARK_SPECIALIST_STALE_HOURS, OR have never run, are silent and their
 *  silence is its own finding. */
export function isStale(lastRunAt: Date | null, now: Date = new Date()): boolean {
  if (!lastRunAt) return true;
  const ageMs = now.getTime() - lastRunAt.getTime();
  return ageMs > env.MARK_SPECIALIST_STALE_HOURS * 3600 * 1000;
}

/** Poll every specialist Mark knows about, sequentially (we don't want to
 *  hammer all 7 at once and we don't need the speed). Returns the per-agent
 *  result list. Errors per-agent are absorbed; the function itself never
 *  throws. */
export async function pollAll(): Promise<PollResult[]> {
  const out: PollResult[] = [];
  for (const desc of specialists()) {
    out.push(await pollSpecialist(desc));
  }
  return out;
}
