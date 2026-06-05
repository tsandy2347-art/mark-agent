// Permission helpers — read the Basic-auth username, decide what's allowed.
//
// We have a simple two-tier model right now:
//   • Full users  — can see and change everything (the default).
//   • View-only   — can see read-only pages, but the mutating ones
//                   (Settings, Payroll journal) are hidden + refused.
//
// Whose username is view-only is controlled by the MARK_VIEWONLY_USERNAMES
// env var (comma-separated, lowercase). Restricted-data access is SEPARATE
// (MARK_RESTRICTED_USERNAMES) — a user can be both restricted-allowed AND
// view-only (e.g. Nicole sees individual-pay findings but cannot tweak
// specialist settings or post payroll journals).

import { headers } from "next/headers";
import { env } from "./env";

export async function currentUsername(): Promise<string | null> {
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

export function viewOnlyUsernames(): string[] {
  return env.MARK_VIEWONLY_USERNAMES
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isViewOnly(username: string | null): boolean {
  if (!username) return false;
  return viewOnlyUsernames().includes(username.toLowerCase());
}
