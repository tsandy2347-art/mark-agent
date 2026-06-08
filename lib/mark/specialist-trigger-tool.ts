// In-chat tool — fire an on-demand re-run of one of Mark's seven specialists.
//
// Specialists run as --no-agent cron scripts on the jbc-hermes brain (NOT as
// standalone HTTP services). This tool triggers them via the brain's
// POST /api/jobs/<job-name>/run endpoint, then polls for completion.
//
// Brain URL + API key are HERMES_API_URL + HERMES_API_SERVER_KEY on Mark.

import Anthropic from "@anthropic-ai/sdk";
import { env, specialists, type SpecialistAgent } from "../env";

export const TRIGGER_SPECIALIST_RUN_TOOL: Anthropic.Messages.Tool = {
  name: "trigger_specialist_run",
  description:
    "Trigger an on-demand re-run of one of the seven finance specialists. " +
    "Use this when the user explicitly asks for fresh data from a specialist " +
    "(e.g. 'rerun the recon', 'recheck claims', 'refresh receivables') OR " +
    "when you realise the cached snapshot is stale and a fresh check is the " +
    "only way to answer them honestly.\n\n" +
    "After the tool returns, ALSO call your existing knowledge of the user's " +
    "question and respond from the FRESH state — the new findings are " +
    "automatically picked up on Mark's next poll cycle (every 30 min), but the " +
    "specialist's response already contains the headline counts you can quote " +
    "immediately.\n\n" +
    "Do not call this tool more than once per specialist per chat turn — these " +
    "runs hit Xero / DB on the specialist side and burning quota is bad. If a " +
    "specialist is not yet wired, the tool returns a clear error; relay it to " +
    "the user, do NOT retry.",
  input_schema: {
    type: "object",
    properties: {
      specialist: {
        type: "string",
        enum: [
          "reconciliation",
          "controls-audit",
          "payroll-labour",
          "payables",
          "revenue-claims",
          "receivables",
          "tax-compliance",
        ],
        description:
          "Which specialist to re-run. Use the canonical name (matches " +
          "Mark's existing /specialists page).",
      },
    },
    required: ["specialist"],
  },
};

// Maps specialist agent names to their brain cron job names
const SPECIALIST_TO_CRON_JOB: Record<string, string> = {
  "reconciliation":  "jbc-reconciliation-daily",
  "controls-audit":  "jbc-controls-audit-daily",
  "payroll-labour":  "jbc-payroll-labour-daily",
  "payables":        "jbc-payables-detector-daily",
  "revenue-claims":  "jbc-revenue-claims-daily",
  "receivables":     "jbc-receivables-daily",
  "tax-compliance":  "jbc-tax-compliance-daily",
};

interface TriggerToolInput {
  specialist?: unknown;
}

export interface TriggerToolResult {
  ok: boolean;
  specialist: string;
  message: string;
  result?: unknown;
}

export async function executeTriggerSpecialistRunTool(
  args: TriggerToolInput,
): Promise<TriggerToolResult> {
  const specialist = typeof args.specialist === "string" ? args.specialist : "";
  const known = specialists().find((s) => s.agent === specialist);
  if (!known) {
    return {
      ok: false,
      specialist,
      message: `Unknown specialist '${specialist}'. Valid: ${specialists().map((s) => s.agent).join(", ")}.`,
    };
  }

  const jobName = SPECIALIST_TO_CRON_JOB[specialist];
  if (!jobName) {
    return {
      ok: false,
      specialist,
      message: `${known.label}: no brain cron job name mapped for '${specialist}'.`,
    };
  }

  const brainUrl = process.env.HERMES_API_URL ?? "https://jbc-hermes-production.up.railway.app";
  const brainKey = process.env.HERMES_API_SERVER_KEY ?? "";

  if (!brainKey) {
    return {
      ok: false,
      specialist,
      message: `HERMES_API_SERVER_KEY not set on Mark — cannot trigger brain job.`,
    };
  }

  // Trigger the cron job on the brain by name via POST /api/jobs/run
  const triggerUrl = `${brainUrl.replace(/\/+$/, "")}/api/jobs/run`;
  const controller = new AbortController();
  // Specialists can take up to 3 min. 4 min cap.
  const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000);

  try {
    const resp = await fetch(triggerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${brainKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ name: jobName }),
      signal: controller.signal,
    });

    const text = await resp.text();
    let parsed: unknown = undefined;
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 500); }

    if (!resp.ok) {
      return {
        ok: false,
        specialist,
        message: `${known.label}: brain returned HTTP ${resp.status} triggering '${jobName}'.`,
        result: parsed,
      };
    }

    return {
      ok: true,
      specialist,
      message: `${known.label} re-run triggered on brain (job: ${jobName}). Results will appear on the next poll cycle.`,
      result: parsed,
    };
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      specialist,
      message: isAbort
        ? `${known.label} brain trigger timed out — the run may still complete; check back on the next poll.`
        : `${known.label} brain trigger failed: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
