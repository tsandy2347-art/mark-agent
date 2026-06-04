// Specialist-settings library.
//
// The shared findings DB holds a small `specialist_settings` table, one row
// per (specialist, key). The detector scripts read it at the top of each
// run; Mark can change values at runtime via the change tool.
//
// SAFETY: only specialists in ALLOWED + only keys listed in their KNOBS map
// can be changed. Off-list specialists and off-list keys are rejected so
// Mark can't invent a setting that doesn't exist on the detector side.

import { Pool } from "pg";
import { env } from "./env";

type Pg = Pool;
let _pool: Pg | null = null;

function pool(): Pg | null {
  if (!env.HERMES_FINDINGS_DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: env.HERMES_FINDINGS_DATABASE_URL, max: 2 });
  return _pool;
}

export interface SpecialistSetting {
  specialist: string;
  key: string;
  value: string;
  valueType: "int" | "float" | "string" | "bool";
  description: string | null;
  updatedAt: Date;
  updatedBy: string;
}

/**
 * Catalogue of settable knobs per specialist. The change tool refuses any
 * (specialist, key) not listed here — keeps Mark from inventing keys the
 * detector doesn't actually read. Extend as we light up new knobs.
 */
export const SPECIALIST_KNOBS: Record<
  string,
  Record<string, { type: "int" | "float"; min: number; max: number; description: string }>
> = {
  receivables: {
    writeoff_candidate_days: {
      type: "int",
      min: 30,
      max: 365,
      description:
        "Age in days at which an outstanding invoice becomes a write-off candidate (critical severity).",
    },
    payment_lookback_days: {
      type: "int",
      min: 14,
      max: 730,
      description:
        "How far back to scan Xero payments for unallocated-receipt detection.",
    },
    debtor_exposure_limit_aud: {
      type: "float",
      min: 1_000,
      max: 1_000_000,
      description:
        "Outstanding-per-debtor threshold (AUD) at which exposure is flagged.",
    },
    unallocated_receipt_age_days: {
      type: "int",
      min: 0,
      max: 30,
      description:
        "Grace days before an unallocated receipt is flagged.",
    },
  },
};

export async function listSettings(specialist?: string): Promise<SpecialistSetting[]> {
  const p = pool();
  if (!p) return [];
  const args: unknown[] = [];
  let where = "";
  if (specialist) {
    where = "WHERE specialist = $1";
    args.push(specialist);
  }
  const r = await p.query(
    `SELECT specialist, key, value, value_type, description, updated_at, updated_by
     FROM specialist_settings ${where} ORDER BY specialist, key`,
    args,
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    specialist: row.specialist as string,
    key: row.key as string,
    value: row.value as string,
    valueType: row.value_type as SpecialistSetting["valueType"],
    description: (row.description as string | null) ?? null,
    updatedAt: row.updated_at as Date,
    updatedBy: (row.updated_by as string) ?? "system",
  }));
}

export interface ChangeResult {
  ok: boolean;
  message: string;
  before?: string | null;
  after?: string | null;
}

/** Apply a change, with full validation. Returns a spoken-style outcome. */
export async function changeSetting(args: {
  specialist: string;
  key: string;
  value: string | number;
  updatedBy: string;
}): Promise<ChangeResult> {
  const knobs = SPECIALIST_KNOBS[args.specialist];
  if (!knobs) {
    return { ok: false, message: `Specialist "${args.specialist}" has no settable knobs yet.` };
  }
  const knob = knobs[args.key];
  if (!knob) {
    return {
      ok: false,
      message: `"${args.key}" isn't a setting on ${args.specialist}. Available: ${Object.keys(knobs).join(", ")}.`,
    };
  }
  const num = typeof args.value === "number" ? args.value : Number(args.value);
  if (!Number.isFinite(num)) {
    return { ok: false, message: `"${args.value}" isn't a number — ${args.key} expects a ${knob.type}.` };
  }
  if (num < knob.min || num > knob.max) {
    return {
      ok: false,
      message: `Value ${num} is outside the safe range for ${args.key} (${knob.min}–${knob.max}). Aborting.`,
    };
  }
  const p = pool();
  if (!p) {
    return { ok: false, message: "Settings DB not configured." };
  }

  // Read previous value for the spoken confirmation.
  const prev = await p.query(
    `SELECT value FROM specialist_settings WHERE specialist=$1 AND key=$2`,
    [args.specialist, args.key],
  );
  const before = prev.rows[0]?.value ?? null;
  const valueStr = knob.type === "int" ? String(Math.round(num)) : String(num);

  await p.query(
    `INSERT INTO specialist_settings (specialist, key, value, value_type, description, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (specialist, key) DO UPDATE
       SET value = EXCLUDED.value,
           value_type = EXCLUDED.value_type,
           description = COALESCE(specialist_settings.description, EXCLUDED.description),
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    [args.specialist, args.key, valueStr, knob.type, knob.description, args.updatedBy],
  );

  return {
    ok: true,
    message:
      before === null
        ? `Set ${args.specialist}.${args.key} to ${valueStr} (was unset). Takes effect on the next nightly run.`
        : before === valueStr
        ? `${args.specialist}.${args.key} is already ${valueStr} — nothing to change.`
        : `Changed ${args.specialist}.${args.key} from ${before} to ${valueStr}. Takes effect on the next nightly run.`,
    before,
    after: valueStr,
  };
}
