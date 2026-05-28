// In-chat tool — fire an on-demand re-run of one of Mark's seven specialists.
//
// Each specialist exposes POST /api/cron/run (Bearer <its-own-CRON_SECRET>).
// That endpoint kicks off the same daily-cron flow the sidecar would have
// fired at 07:00 AEST. Returns once the run completes (specialist-side
// timing varies — recon is ~3-5s, controls-audit ~3min depending on Xero).
//
// Mark doesn't share a single Bearer with the specialists for /api/cron/run
// (unlike /api/findings which uses HUB_API_KEY). Each specialist has its own
// CRON_SECRET. Mark holds them as SPECIALIST_<AGENT>_CRON_SECRET env vars.
// A specialist with no secret configured returns a clear "not wired" error
// — the user (Tony) sees the gap and fills it in Railway.

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
    "specialist is not yet wired (no CRON_SECRET on Mark for it), the tool " +
    "returns a clear error; relay it to the user, do NOT retry.",
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

interface TriggerToolInput {
  specialist?: unknown;
}

export interface TriggerToolResult {
  ok: boolean;
  specialist: string;
  message: string;
  /** Free-form structured result from the specialist when available — counts,
   *  IDs, severity buckets. Mark relays the headline numbers verbatim. */
  result?: unknown;
}

function _secretFor(agent: SpecialistAgent): string {
  const key = `SPECIALIST_${agent.replace(/-/g, "_").toUpperCase()}_CRON_SECRET`;
  return process.env[key] ?? "";
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
  if (!known.url) {
    return {
      ok: false,
      specialist,
      message: `${known.label}: no URL configured on Mark — SPECIALIST_${specialist.replace(/-/g, "_").toUpperCase()}_URL is blank.`,
    };
  }
  const secret = _secretFor(specialist as SpecialistAgent);
  if (!secret) {
    return {
      ok: false,
      specialist,
      message:
        `${known.label}: no CRON_SECRET configured on Mark — set ` +
        `SPECIALIST_${specialist.replace(/-/g, "_").toUpperCase()}_CRON_SECRET ` +
        `to the value of CRON_SECRET on the ${specialist} service. Until then ` +
        `I can't trigger this one on-demand; it will still run on its daily cron.`,
    };
  }

  const url = `${known.url.replace(/\/+$/, "")}/api/cron/run`;
  const controller = new AbortController();
  // Specialists are slow (controls-audit can be ~3 min). 4 min cap so we
  // still return inside Mark's chat window.
  const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 500);
    }

    if (!resp.ok) {
      return {
        ok: false,
        specialist,
        message: `${known.label} returned HTTP ${resp.status}.`,
        result: parsed,
      };
    }
    return {
      ok: true,
      specialist,
      message: `${known.label} re-run complete.`,
      result: parsed,
    };
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      specialist,
      message: isAbort
        ? `${known.label} did not respond within 4 min — the run may still finish; check back via /api/findings on the next poll.`
        : `${known.label} request failed: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
