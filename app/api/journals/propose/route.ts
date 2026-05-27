// POST /api/journals/propose — file → AI-proposed manual journal lines.
//
// Mark accepts a file (xlsx/csv) plus a hint about what kind of journal it
// represents, and asks Claude to propose balanced DR/CR lines. The proposal
// is returned to the UI for the human to review and edit. Nothing is
// written to Xero by this endpoint — that's /api/journals/create's job
// AFTER the human clicks "Create draft".
//
// Body (multipart/form-data):
//   - file: the source spreadsheet
//   - entity: "SC" | "CQ"
//   - hint: free-text describing the journal type (e.g. "payroll accrual",
//           "depreciation", "FX revaluation", "intercompany clearing")
//
// Response:
//   200 { ok:true, proposal: { narration, date, lines:[{amount,side,
//                                accountCode,description}], rationale } }
//   400 on validation
//   502 on Anthropic / file-parse failure (UI lets human fall back to
//       the manual draft page on recon)

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_BYTES = 20 * 1024 * 1024;

const PROPOSE_TOOL: Anthropic.Messages.Tool = {
  name: "propose_manual_journal",
  description:
    "Propose a single balanced manual journal entry based on the attached file. " +
    "Use this when the file represents a journal you'd post (payroll, accrual, " +
    "FX reval, depreciation, intercompany, etc.). Return cannot_propose: true " +
    "with an explanation if the file isn't a journal source.",
  input_schema: {
    type: "object",
    properties: {
      cannot_propose: {
        type: "boolean",
        description: "Set true when the file doesn't make sense as a journal source.",
      },
      cannot_propose_reason: {
        type: "string",
        description: "Plain-English reason when cannot_propose is true.",
      },
      narration: {
        type: "string",
        description:
          "Human-readable narration for the journal (will appear in Xero). " +
          "Keep concise; the system auto-suffixes a 'DRAFT — auto-generated' tag.",
      },
      date: {
        type: "string",
        description: "yyyy-mm-dd journal date. Pick the most relevant date from the file.",
      },
      lines: {
        type: "array",
        description:
          "Balanced journal lines. Total DR must equal total CR. At least 2 lines.",
        items: {
          type: "object",
          properties: {
            amount: { type: "number", description: "Positive amount in AUD." },
            side: { type: "string", enum: ["DR", "CR"], description: "DR or CR." },
            accountCode: {
              type: "string",
              description:
                "JBC Xero account code as best you can infer (e.g. '6010' for wages, " +
                "'2100' for PAYG payable). When unsure, pick a plausible code and " +
                "note it in description so the human can correct.",
            },
            description: {
              type: "string",
              description: "Optional per-line description shown in Xero.",
            },
          },
          required: ["amount", "side", "accountCode"],
        },
      },
      rationale: {
        type: "string",
        description:
          "One paragraph explaining how you read the file and chose the lines. " +
          "Mention any assumptions the human should verify (account codes, " +
          "date, scope).",
      },
    },
  },
};

const PROPOSE_SYSTEM = `You are a senior accountant assisting JBC's finance team. You're shown a
spreadsheet and asked to propose a single balanced manual journal that captures
what the file represents.

Hard rules:
- The journal is DRAFT only. A human reviews and posts in Xero — you never post.
- Total DR must equal total CR exactly (within 1c). Refuse to propose unbalanced.
- Use the propose_manual_journal tool to return your proposal. Free-text replies
  are ignored.
- Brisbane time and currency (AUD) everywhere.
- If the file isn't a journal source (it's a list of contacts, a marketing PDF,
  etc.), set cannot_propose=true with a plain-English reason. Don't force a
  proposal just to have one.
- Account codes: pick the most plausible JBC account code from common chart
  conventions (4xxx revenue, 5xxx COGS, 6xxx expenses, 1xxx assets, 2xxx
  liabilities, 3xxx equity). If unsure, note it in the line description so the
  human can correct before posting.
- When the entity hint is "SC" the journal is for Just Better Care Sunshine
  Coast Pty Ltd; "CQ" is Just Better Care Central Queensland Pty Ltd. Keep the
  proposal entity-specific — don't mix.
- Be conservative on rationale. If you're guessing on a line, say so.`;

interface ProposedLine {
  amount: number;
  side: "DR" | "CR";
  accountCode: string;
  description?: string;
}

interface Proposal {
  narration: string;
  date: string;
  lines: ProposedLine[];
  rationale: string;
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

async function spreadsheetToText(filename: string, buf: Buffer): Promise<{ text: string; sheetCount: number; rowCount: number; truncated: boolean }> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });
  const cap = 60_000;
  const parts: string[] = [];
  parts.push(`File: ${filename}`);
  parts.push(`Sheets: ${wb.SheetNames.length}`);
  let used = 0;
  let totalRows = 0;
  let truncated = false;
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, FS: ",", RS: "\n" });
    const head = `\n--- Sheet: ${name} ---\n`;
    if (used + head.length >= cap) {
      truncated = true;
      break;
    }
    parts.push(head);
    used += head.length;
    if (csv.length > cap - used) {
      parts.push(csv.slice(0, cap - used));
      parts.push(`\n[…sheet truncated…]`);
      used = cap;
      truncated = true;
      break;
    }
    parts.push(csv);
    used += csv.length;
    totalRows += csv.split("\n").length;
  }
  return { text: parts.join(""), sheetCount: wb.SheetNames.length, rowCount: totalRows, truncated };
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
  const file = form.get("file");
  const entity = String(form.get("entity") ?? "").trim().toUpperCase();
  const hint = String(form.get("hint") ?? "").trim();

  if (!file || typeof file === "string") {
    return NextResponse.json({ ok: false, error: "file required" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ ok: false, error: "file is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `file too large (${(file.size / 1_048_576).toFixed(1)} MB, max 20 MB)` },
      { status: 400 },
    );
  }
  if (entity !== "SC" && entity !== "CQ") {
    return NextResponse.json({ ok: false, error: "entity must be SC or CQ" }, { status: 400 });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "ANTHROPIC_API_KEY not configured on Mark" },
      { status: 500 },
    );
  }

  const buf = Buffer.from(new Uint8Array(await file.arrayBuffer()));

  let sheetInfo: { text: string; sheetCount: number; rowCount: number; truncated: boolean };
  try {
    sheetInfo = await spreadsheetToText(file.name || "uploaded", buf);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `failed to parse file: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }

  const me = (await currentUsername()) ?? "anonymous";

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let resp;
  try {
    resp = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 2500,
      system: PROPOSE_SYSTEM,
      tools: [PROPOSE_TOOL],
      tool_choice: { type: "tool", name: "propose_manual_journal" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Entity: ${entity} (${entity === "SC" ? "Just Better Care Sunshine Coast" : "Just Better Care Central Queensland"})\n` +
                `Requested by: ${me}\n` +
                (hint ? `Hint about the journal type: ${hint}\n\n` : "\n") +
                `Below is the spreadsheet content (parsed to CSV text). Propose a single balanced manual journal that captures it.\n\n` +
                sheetInfo.text +
                (sheetInfo.truncated ? "\n\n[NOTE: file was truncated for context window]" : ""),
            },
          ],
        },
      ],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Anthropic call failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const toolUse = resp.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "propose_manual_journal",
  );
  if (!toolUse) {
    return NextResponse.json(
      { ok: false, error: "model did not return a proposal" },
      { status: 502 },
    );
  }
  const input = toolUse.input as Record<string, unknown>;

  if (input.cannot_propose) {
    return NextResponse.json({
      ok: false,
      cannotPropose: true,
      reason: typeof input.cannot_propose_reason === "string"
        ? input.cannot_propose_reason
        : "model declined to propose a journal from this file",
    });
  }

  // Shape-check the proposal before returning.
  const narration = typeof input.narration === "string" ? input.narration.trim() : "";
  const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
    ? input.date
    : new Date().toISOString().slice(0, 10);
  const rationale = typeof input.rationale === "string" ? input.rationale : "";
  const linesRaw = Array.isArray(input.lines) ? input.lines : [];
  const lines: ProposedLine[] = [];
  for (const l of linesRaw) {
    if (typeof l !== "object" || l == null) continue;
    const ll = l as { amount?: unknown; side?: unknown; accountCode?: unknown; description?: unknown };
    const amount = typeof ll.amount === "number" ? ll.amount : Number(ll.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (ll.side !== "DR" && ll.side !== "CR") continue;
    if (typeof ll.accountCode !== "string" || !ll.accountCode.trim()) continue;
    lines.push({
      amount,
      side: ll.side,
      accountCode: ll.accountCode.trim(),
      description: typeof ll.description === "string" ? ll.description : undefined,
    });
  }

  if (!narration || lines.length < 2) {
    return NextResponse.json(
      { ok: false, error: "model returned an incomplete proposal — try again or use the manual /journals/draft page" },
      { status: 502 },
    );
  }

  const totalDr = lines.filter((l) => l.side === "DR").reduce((s, l) => s + l.amount, 0);
  const totalCr = lines.filter((l) => l.side === "CR").reduce((s, l) => s + l.amount, 0);

  const proposal: Proposal & { totalDr: number; totalCr: number; balanced: boolean } = {
    narration,
    date,
    lines,
    rationale,
    totalDr,
    totalCr,
    balanced: Math.abs(totalDr - totalCr) <= 0.01,
  };

  return NextResponse.json({
    ok: true,
    entity,
    proposal,
    sourceFile: {
      filename: file.name,
      byteSize: file.size,
      sheetCount: sheetInfo.sheetCount,
      truncated: sheetInfo.truncated,
    },
  });
}
