// POST /api/payroll-journal — deterministic MYOB → Craig-pattern journal preview.
//
// Mark is the UPLOAD FRONT DOOR for the payroll-journal function. The actual
// build is done by the deterministic parser (scripts/payroll/parse_myob_payroll.py,
// pure stdlib) — same files in, same exact journal out, every time. We do NOT
// narrate this through a chat model; exactness matters for journals.
//
// This route is PREVIEW-ONLY: it runs the parser WITHOUT --post-draft, so it
// reads the three MYOB xlsx files, builds the SC + CQ journals, and returns the
// exact lines + totals for human review. It touches NO source system and needs
// NO Xero credentials — Mark deliberately holds none.
//
// Posting the DRAFT to Xero (which needs the SC/CQ keys) is a separate step
// wired to the keys-holding service; it is intentionally not in this route.
//
// Auth is enforced upstream by proxy.ts (Basic). We decode the header only to
// stamp who ran it, for the audit line.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
const PARSER = path.join(process.cwd(), "scripts/payroll/parse_myob_payroll.py");
// nixpacks python311 provides `python3`; local macOS dev has it too.
const PYTHON = process.env.PYTHON_BIN || "python3";

async function currentPeer(): Promise<string> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth?.startsWith("Basic ")) return "anonymous";
  try {
    return Buffer.from(auth.slice(6), "base64").toString().split(":")[0].toLowerCase() || "anonymous";
  } catch {
    return "anonymous";
  }
}

function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

/** Run the parser and resolve its parsed JSON (or reject with stderr). */
function runParser(summaryPath: string, dataPath: string, detailPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = [PARSER, summaryPath, dataPath, detailPath, "--json"];
    const proc = spawn(PYTHON, args, { env: { ...process.env } });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", (e) => reject(new Error(`could not start parser: ${e.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`parser exited ${code}: ${err.slice(0, 800)}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        reject(new Error(`parser produced non-JSON output. stderr: ${err.slice(0, 400)} | stdout head: ${out.slice(0, 400)}`));
      }
    });
  });
}

export async function POST(req: NextRequest) {
  // View-only users (Nicole, Lindsay) cannot upload pay runs. Tony only.
  const { currentUsername, isViewOnly } = await import("@/lib/permissions");
  const me = await currentUsername();
  if (isViewOnly(me)) {
    return NextResponse.json(
      { ok: false, error: "view-only login — payroll-journal upload is Tony-only" },
      { status: 403 },
    );
  }
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    return fail("Content-Type must be multipart/form-data");
  }

  const form = await req.formData();
  const summary = form.get("summary");
  const data = form.get("data");
  const detail = form.get("detail");

  for (const [name, f] of [["summary", summary], ["data", data], ["detail", detail]] as const) {
    if (!f || typeof f === "string") return fail(`${name} file is required`);
    if (f.size === 0) return fail(`${name} file is empty`);
    if (f.size > MAX_BYTES) return fail(`${name} file too large (max 25 MB)`);
    if (!f.name.toLowerCase().endsWith(".xlsx")) return fail(`${name} must be a .xlsx file`);
  }

  const peer = await currentPeer();
  const dir = await mkdtemp(path.join(tmpdir(), "mark-payroll-"));
  try {
    const summaryBuf = Buffer.from(await (summary as File).arrayBuffer());
    const dataBuf = Buffer.from(await (data as File).arrayBuffer());
    const detailBuf = Buffer.from(await (detail as File).arrayBuffer());
    const summaryPath = path.join(dir, "summary.xlsx");
    const dataPath = path.join(dir, "data.xlsx");
    const detailPath = path.join(dir, "detail.xlsx");
    await writeFile(summaryPath, summaryBuf);
    await writeFile(dataPath, dataBuf);
    await writeFile(detailPath, detailBuf);

    const parsed = await runParser(summaryPath, dataPath, detailPath);

    // Persist the exact file SET + preview so the payroll agent can later
    // fetch and post from the same bytes. Append-only; newest wins.
    const upload = await prisma.payrollUpload.create({
      data: {
        summaryName: (summary as File).name,
        summaryBytes: summaryBuf,
        dataName: (data as File).name,
        dataBytes: dataBuf,
        detailName: (detail as File).name,
        detailBytes: detailBuf,
        previewJson: parsed as object,
        uploadedBy: peer,
      },
      select: { id: true },
    });

    return NextResponse.json({ ok: true, ranBy: peer, uploadId: upload.id, result: parsed });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
