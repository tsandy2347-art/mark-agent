// GET /api/imports/[kind]/latest — read endpoint for the Hermes skills.
//
// jbc-payroll-labour fetches kind=myob; jbc-revenue-claims fetches
// kind=alayacare. Returns the raw bytes of the most recently uploaded file,
// plus headers identifying the row so the skill can stamp processedRunId on
// it later (out of scope here — skill side handles that via a separate
// callback when we wire it up).
//
// Auth: same Basic auth as everything else (proxy.ts). The skills send the
// same Authorization header (env MARK_IMPORT_AUTH on the skill side).

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const ALLOWED_KINDS = new Set(["myob", "alayacare"]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ kind: string }> },
) {
  const { kind } = await params;
  const k = kind.toLowerCase();
  if (!ALLOWED_KINDS.has(k)) {
    return NextResponse.json({ ok: false, error: `unknown kind: ${kind}` }, { status: 400 });
  }

  const row = await prisma.csvImport.findFirst({
    where: { kind: k },
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      bytes: true,
      uploadedAt: true,
      uploadedBy: true,
      entityCode: true,
    },
  });

  if (!row) {
    return NextResponse.json(
      { ok: false, error: `no ${k} import has been uploaded yet` },
      { status: 404 },
    );
  }

  const body = new Uint8Array(row.bytes as Buffer);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      "Content-Length": String(row.sizeBytes),
      "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
      "X-Mark-Import-Id": row.id,
      "X-Mark-Import-Filename": row.filename,
      "X-Mark-Import-Uploaded-At": row.uploadedAt.toISOString(),
      "X-Mark-Import-Uploaded-By": row.uploadedBy,
      "X-Mark-Import-Entity-Code": row.entityCode ?? "",
      "Cache-Control": "no-store",
    },
  });
}
