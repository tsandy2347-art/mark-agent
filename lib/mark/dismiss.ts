// Dismiss links on brief items.
//
// Every line in the emailed brief carries a signed link to /f/<token>. The
// page offers Done / Wrong / Snooze a week, plus "not a care supplier" on
// vetting checks. The answer is stored as a FindingSuppression and applied in
// fetchOpenFindings, so a detector re-raising the same item tomorrow does not
// put it back in front of Tony.
//
// Why a signed link and not Basic auth: the brief is read on a phone in a mail
// app, and a login prompt there is the difference between using this and not.
// The token names one brief line (a CorrelatedIssue id) and is HMAC-signed
// with a key derived from CRON_SECRET; it only ever reaches the brief's
// recipients, and it expires with the brief (LINK_TTL_DAYS).

import crypto from "node:crypto";
import type { IngestedFinding } from "../generated/prisma";
import { env } from "../env";
import { prisma } from "../prisma";

export const LINK_TTL_DAYS = 30;
export const SNOOZE_DAYS = 7;

export type DismissAction = "done" | "wrong" | "snooze" | "not-care-supplier";

/** Vetting checks — the only ones "not a care supplier" may silence. A
 *  business supplier (recruiter, insurer, utility) is legitimately never in
 *  the compliance hub, so these fire on it forever. Bank-detail changes,
 *  duplicates and ABN problems are deliberately absent: those are fraud and
 *  payment-accuracy signals and are dismissed one at a time or not at all. */
export const VETTING_DETECTORS = [
  "new-supplier-quarantine",
  "new-supplier",
  "paid-invoice-unlinked",
] as const;

function signingKey(): Buffer {
  const secret = env.CRON_SECRET || "";
  if (!secret) throw new Error("CRON_SECRET is not set — dismiss links are disabled");
  return crypto.createHmac("sha256", secret).update("mark:brief-dismiss:v1").digest();
}

function sig(issueId: string): string {
  return crypto.createHmac("sha256", signingKey()).update(issueId).digest("base64url").slice(0, 22);
}

export function linksEnabled(): boolean {
  return Boolean(env.CRON_SECRET);
}

export function dismissToken(issueId: string): string {
  return `${issueId}.${sig(issueId)}`;
}

/** The CorrelatedIssue id, or null when the token is malformed or forged. */
export function verifyDismissToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  let expected: Buffer;
  try {
    expected = Buffer.from(sig(id));
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return id;
}

export function publicBaseUrl(): string {
  const explicit = process.env.MARK_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  return domain ? `https://${domain}` : "";
}

export function dismissUrl(issueId: string): string | null {
  const base = publicBaseUrl();
  if (!base || !linksEnabled()) return null;
  return `${base}/f/${dismissToken(issueId)}`;
}

// ── identities ───────────────────────────────────────────────────

function evidenceOf(f: Pick<IngestedFinding, "evidenceJson">): Record<string, unknown> {
  const ev = f.evidenceJson;
  return ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {};
}

/** Mirrors identity_of() in jbc-hermes-skills lib/findings_sweep.py — the key
 *  every runner dedups on — so a re-raised copy of a finding matches. */
export function findingIdentity(
  f: Pick<IngestedFinding, "evidenceJson" | "specialistAgent" | "entityCode" | "title">,
): string {
  const key = evidenceOf(f).dedupKey;
  if (typeof key === "string" && key) return key;
  return `${f.specialistAgent}:${f.entityCode}:${f.title}`;
}

export function normaliseSupplier(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // "(NDIS Provider) Premier Mowing", "(formerly …)"
    .replace(/\b(pty|ltd|limited|the|t\/a|trading as)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

/** The supplier a vetting finding is about, or null when the finding is not a
 *  vetting check (or names no supplier). hub-supplier-bypass is excluded: that
 *  is a known supplier paid around the approval flow, a process breach, not a
 *  vetting question. */
export function vettingSupplierKey(
  f: Pick<IngestedFinding, "evidenceJson" | "detector">,
): string | null {
  if (!(VETTING_DETECTORS as readonly string[]).includes(f.detector)) return null;
  const ev = evidenceOf(f);
  if (f.detector === "paid-invoice-unlinked" && ev.subkind !== "unvetted-vendor") return null;
  const name = [ev.supplierName, ev.xeroContactName, ev.contactName].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  const key = name ? normaliseSupplier(name) : "";
  return key || null;
}

export function supplierDisplayName(f: Pick<IngestedFinding, "evidenceJson">): string | null {
  const ev = evidenceOf(f);
  const name = [ev.supplierName, ev.xeroContactName, ev.contactName].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return name ?? null;
}

// ── applying suppressions ────────────────────────────────────────

export interface ActiveSuppressions {
  identities: Set<string>;
  /** `${entityCode}|${detector}|${supplierKey}` */
  supplierKeys: Set<string>;
}

export async function loadActiveSuppressions(now = new Date()): Promise<ActiveSuppressions> {
  const rows = await prisma.findingSuppression.findMany({
    where: { OR: [{ until: null }, { until: { gt: now } }] },
    select: { scope: true, identity: true, supplierKey: true, detectors: true, entityCode: true },
  });
  const identities = new Set<string>();
  const supplierKeys = new Set<string>();
  for (const r of rows) {
    if (r.scope === "finding" && r.identity) identities.add(r.identity);
    if (r.scope === "supplier" && r.supplierKey) {
      const dets = Array.isArray(r.detectors) ? (r.detectors as string[]) : [...VETTING_DETECTORS];
      for (const d of dets) supplierKeys.add(`${r.entityCode}|${d}|${r.supplierKey}`);
    }
  }
  return { identities, supplierKeys };
}

export function isSuppressed(f: IngestedFinding, s: ActiveSuppressions): boolean {
  if (s.identities.has(findingIdentity(f))) return true;
  const key = vettingSupplierKey(f);
  return key != null && s.supplierKeys.has(`${f.entityCode}|${f.detector}|${key}`);
}

/** Drop dismissed / snoozed findings. If the suppression table can't be read
 *  the brief still goes out unfiltered — showing a dismissed item again is
 *  better than sending no brief. */
export async function withoutSuppressed(findings: IngestedFinding[]): Promise<IngestedFinding[]> {
  let s: ActiveSuppressions;
  try {
    s = await loadActiveSuppressions();
  } catch (e) {
    console.error("[dismiss] could not load suppressions — brief unfiltered:", e);
    return findings;
  }
  if (s.identities.size === 0 && s.supplierKeys.size === 0) return findings;
  return findings.filter((f) => !isSuppressed(f, s));
}
