// POST /api/imports/upload — Tony / Lindsay drop CSV/PDF exports here.
//
// Stores the raw bytes in Postgres so the read-only Hermes skills running on
// a separate Railway service (different volume) can fetch them over HTTP via
// GET /api/imports/[kind]/latest on each run.
//
// Basic auth is enforced upstream by proxy.ts. We just decode the header to
// stamp `uploadedBy` for the audit trail.
//
// Multipart form fields:
//   - kind        "myob" | "alayacare"        (required)
//   - file        the actual CSV / XLSX / PDF  (required, ≤ 50 MB)
//   - entityCode  "SC" | "CQ" | ""             (optional)
//   - notes       free text                    (optional)

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_KINDS = new Set(["myob", "alayacare"]);
const ALLOWED_MIME = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "",
]);

async function currentPeer(): Promise<string> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth?.startsWith("Basic ")) return "user:anonymous";
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const user = decoded.split(":")[0].toLowerCase();
    return `user:${user || "anonymous"}`;
  } catch {
    return "user:anonymous";
  }
}

function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    return fail("Content-Type must be multipart/form-data");
  }

  const form = await req.formData();
  const kind = String(form.get("kind") ?? "").trim().toLowerCase();
  const entityCodeRaw = String(form.get("entityCode") ?? "").trim().toUpperCase();
  const notes = String(form.get("notes") ?? "").trim() || null;
  const file = form.get("file");

  if (!ALLOWED_KINDS.has(kind)) {
    return fail(`unknown kind: ${kind} (expected "myob" or "alayacare")`);
  }
  if (!file || typeof file === "string") return fail("file required");
  if (file.size === 0) return fail("file is empty");
  if (file.size > MAX_BYTES) {
    return fail(`file too large (${(file.size / 1_048_576).toFixed(1)} MB, max 50 MB)`);
  }
  const mime = (file.type || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return fail(`mime type not accepted: ${mime || "(blank)"}`);
  }

  const entityCode = entityCodeRaw === "SC" || entityCodeRaw === "CQ" ? entityCodeRaw : null;
  const bytes = Buffer.from(new Uint8Array(await file.arrayBuffer()));
  const uploadedBy = await currentPeer();

  const row = await prisma.csvImport.create({
    data: {
      kind,
      entityCode,
      filename: file.name || "uploaded",
      mimeType: mime || "application/octet-stream",
      sizeBytes: file.size,
      bytes,
      uploadedBy,
      notes,
    },
    select: { id: true, kind: true, filename: true, sizeBytes: true, uploadedAt: true, uploadedBy: true },
  });

  // If posted from the /imports page (browser form), redirect back. JSON
  // callers get JSON.
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return NextResponse.redirect(new URL("/imports", req.url), { status: 303 });
  }
  return NextResponse.json({ ok: true, import: row });
}
