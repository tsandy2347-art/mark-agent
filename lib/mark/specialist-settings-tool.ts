// In-chat tool — let Mark change a setting on a specialist agent.
//
// Mark has authority over the specialists' knobs (thresholds, grace days,
// exposure limits). The actual values live in the `specialist_settings`
// DB row that each detector reads at the start of its nightly run. So when
// Mark calls this tool the change is durable, audited (updated_by = who
// asked Mark), and active from the next run — no redeploy needed.
//
// SAFETY: the underlying changeSetting() only accepts (specialist, key)
// pairs listed in SPECIALIST_KNOBS, and every value is range-clamped.
// Mark can never invent a setting that doesn't exist or push a number
// outside the safe range.

import Anthropic from "@anthropic-ai/sdk";
import { changeSetting, SPECIALIST_KNOBS } from "../specialist-settings";

const SUPPORTED_SPECIALISTS = Object.keys(SPECIALIST_KNOBS);

// Build the per-specialist key list at module load.
const KNOB_HINT = SUPPORTED_SPECIALISTS.map((sp) => {
  const ks = Object.keys(SPECIALIST_KNOBS[sp]).join(", ");
  return `${sp}: ${ks}`;
}).join(" | ");

export const CHANGE_SPECIALIST_SETTING_TOOL: Anthropic.Messages.Tool = {
  name: "change_specialist_setting",
  description:
    "Change a tunable threshold on one of your specialist agents. Use when " +
    "the user asks you to adjust a knob (e.g. 'have Monty chase at 90 days', " +
    "'drop the write-off threshold to 100 days', 'flag exposure above 50k'). " +
    "Currently available knobs — " + KNOB_HINT + ". Always READ the user's " +
    "intent back before calling — confirm the specialist name, the knob and " +
    "the new value in one sentence ('Just to confirm, Sir — Monty's write-off " +
    "threshold from one-twenty days down to ninety?'). The change is durable " +
    "and takes effect on the NEXT nightly run (overnight); say so in your " +
    "confirmation. If the user names a specialist that isn't listed here, " +
    "explain plainly that that one isn't yet wired for runtime changes and " +
    "you'll note it for the team to add — do NOT call this tool.",
  input_schema: {
    type: "object",
    properties: {
      specialist: {
        type: "string",
        enum: SUPPORTED_SPECIALISTS,
        description:
          "The specialist agent slug. Use the slug, not the person name (e.g. 'receivables' not 'Monty').",
      },
      key: {
        type: "string",
        description:
          "The settable knob name. Must be one of the keys listed for that specialist (see this tool's description).",
      },
      value: {
        type: "number",
        description: "The new numeric value.",
      },
    },
    required: ["specialist", "key", "value"],
  },
};

export interface ChangeToolInput {
  specialist?: unknown;
  key?: unknown;
  value?: unknown;
}

export async function executeChangeSpecialistSettingTool(args: {
  input: ChangeToolInput;
  triggeredBy: string;
}): Promise<{ ok: boolean; message: string; before?: string | null; after?: string | null }> {
  const specialist = typeof args.input.specialist === "string" ? args.input.specialist : "";
  const key = typeof args.input.key === "string" ? args.input.key : "";
  const value =
    typeof args.input.value === "number"
      ? args.input.value
      : typeof args.input.value === "string"
      ? Number(args.input.value)
      : NaN;

  if (!specialist) {
    return { ok: false, message: 'Missing "specialist".' };
  }
  if (!key) {
    return { ok: false, message: 'Missing "key".' };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, message: 'Missing or non-numeric "value".' };
  }

  return changeSetting({
    specialist,
    key,
    value,
    updatedBy: args.triggeredBy,
  });
}
