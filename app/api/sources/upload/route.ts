// POST /api/sources/upload — Mark's fleet-wide source-data upload hub.
// Basic-auth gated by proxy.ts. Routes uploads to the specialist that owns
// the source type, forwarding via Bearer HUB_API_KEY to each specialist's
// /api/sources/inbound endpoint.
//
// Body (multipart/form-data):
//   - sourceType: string (matches one of SOURCE_ROUTES)
//   - entityCode: "SC" | "CQ" (optional)
//   - file: the actual file
//
// Response:
//   200 { ok, sourceType, target, ingestBatchId, sheetSummary, byteSize,
//         isDuplicate, ... }
//   400 on validation
//   500 on downstream failure
//
// Cap: 30MB per file (matches specialist's inbound cap). xlsx / xls / csv
// accepted today; expand the accept list as Phase 1B adds source types.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_BYTES = 30 * 1024 * 1024;

/** Routing table: source-type → which specialist owns the inbound endpoint.
 *  Each entry shows up in the hub UI; only those with `targetUrl` set are
 *  actually upload-able. The rest are placeholders so the roadmap is
 *  visible. */
interface SourceRoute {
  sourceType: string;
  label: string;
  ownerLabel: string;
  /** Which env var holds the specialist's base URL. */
  ownerEnvKey:
    | "SPECIALIST_PAYROLL_LABOUR_URL"
    | "SPECIALIST_REVENUE_CLAIMS_URL"
    | "SPECIALIST_RECONCILIATION_URL"
    | "SPECIALIST_TAX_COMPLIANCE_URL"
    | "SPECIALIST_PAYABLES_URL";
  /** When false, the hub UI shows "coming next" and the upload endpoint
   *  rejects with 501. */
  available: boolean;
  /** When set, point the user at an existing external tool instead of
   *  routing through Mark (e.g. Mirus → payroll-analyser's mature UI). */
  externalUrl?: string;
}

const SOURCE_ROUTES: SourceRoute[] = [
  {
    sourceType: "myob-pay-export",
    label: "MYOB Pay Export",
    ownerLabel: "Payroll & Labour Agent",
    ownerEnvKey: "SPECIALIST_PAYROLL_LABOUR_URL",
    available: true,
  },
  {
    sourceType: "alayacare-roster",
    label: "AlayaCare — Roster Export",
    ownerLabel: "Payroll & Labour Agent",
    ownerEnvKey: "SPECIALIST_PAYROLL_LABOUR_URL",
    available: false,
  },
  {
    sourceType: "alayacare-billable",
    label: "AlayaCare — Billable Visits Export",
    ownerLabel: "Revenue & Claims Agent",
    ownerEnvKey: "SPECIALIST_REVENUE_CLAIMS_URL",
    available: false,
  },
  {
    sourceType: "ndis-papl",
    label: "NDIS Price Arrangements (PAPL XLSX)",
    ownerLabel: "Revenue & Claims Agent",
    ownerEnvKey: "SPECIALIST_REVENUE_CLAIMS_URL",
    available: false,
  },
  {
    sourceType: "bank-csv",
    label: "Bank Statement CSV",
    ownerLabel: "Reconciliation Agent",
    ownerEnvKey: "SPECIALIST_RECONCILIATION_URL",
    available: false,
  },
  {
    sourceType: "tax-workpaper",
    label: "Tax Workpaper / GST Mapping",
    ownerLabel: "Tax & Compliance Agent",
    ownerEnvKey: "SPECIALIST_TAX_COMPLIANCE_URL",
    available: false,
  },
  {
    sourceType: "mirus-post-data",
    label: "Mirus Post-Payroll Data",
    ownerLabel: "Payroll Analyser (separate tool)",
    ownerEnvKey: "SPECIALIST_PAYROLL_LABOUR_URL", // unused for external
    available: false,
    externalUrl: "https://jbc-payroll-analyser-production.up.railway.app/",
  },
];

export function sourceRoutes(): SourceRoute[] {
  return SOURCE_ROUTES;
}

async function currentUsername(): Promise<string | null> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    return decoded.split(":")[0].toLowerCase();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be multipart/form-data" },
      { status: 400 },
    );
  }

  const form = await req.formData();
  const sourceType = String(form.get("sourceType") ?? "").trim();
  const entityCode = String(form.get("entityCode") ?? "").trim().toUpperCase();
  const file = form.get("file");

  const route = SOURCE_ROUTES.find((r) => r.sourceType === sourceType);
  if (!route) {
    return NextResponse.json(
      { ok: false, error: `unknown sourceType: ${sourceType}` },
      { status: 400 },
    );
  }
  if (route.externalUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: `${route.label} is handled by a separate tool — upload directly at ${route.externalUrl}`,
        externalUrl: route.externalUrl,
      },
      { status: 400 },
    );
  }
  if (!route.available) {
    return NextResponse.json(
      { ok: false, error: `${route.label} ingest is coming next — not wired yet` },
      { status: 501 },
    );
  }

  if (!file || typeof file === "string") {
    return NextResponse.json({ ok: false, error: "file required" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ ok: false, error: "file is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `file too large (${(file.size / 1_048_576).toFixed(1)} MB, max 30 MB)` },
      { status: 400 },
    );
  }

  const baseUrl = env[route.ownerEnvKey];
  if (!baseUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: `${route.ownerLabel} URL not configured (${route.ownerEnvKey} env var is empty on Mark)`,
      },
      { status: 500 },
    );
  }
  if (!env.HUB_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "HUB_API_KEY not configured on Mark — can't forward to specialist" },
      { status: 500 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = Buffer.from(bytes).toString("base64");

  const me = (await currentUsername()) ?? "anonymous";
  const uploadedBy = `user:${me}`;

  const downstreamUrl = `${baseUrl.replace(/\/$/, "")}/api/sources/inbound`;
  let downstreamResp: Response;
  try {
    downstreamResp = await fetch(downstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.HUB_API_KEY}`,
      },
      body: JSON.stringify({
        sourceType,
        entityCode: entityCode === "SC" || entityCode === "CQ" ? entityCode : null,
        filename: file.name || "uploaded",
        base64,
        uploadedBy,
      }),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `failed to reach ${route.ownerLabel}: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  }

  const downstreamJson = await downstreamResp.json().catch(() => ({}));
  if (!downstreamResp.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          (downstreamJson as { error?: string }).error ??
          `${route.ownerLabel} returned HTTP ${downstreamResp.status}`,
        target: route.ownerLabel,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    sourceType,
    sourceLabel: route.label,
    target: route.ownerLabel,
    uploadedBy,
    ...downstreamJson,
  });
}
