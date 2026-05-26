// Brisbane is UTC+10 year-round (no DST). We never show raw UTC.

import { DateTime } from "luxon";

const ZONE = "Australia/Brisbane";

/** Format a Date as "Mon 25 May 2026, 17:24 AEST". */
export function brisbane(d: Date | string): string {
  const dt = typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d);
  return dt.setZone(ZONE).toFormat("ccc d LLL yyyy, HH:mm 'AEST'");
}

/** Short: "25 May 17:24". */
export function brisbaneShort(d: Date | string): string {
  const dt = typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d);
  return dt.setZone(ZONE).toFormat("d LLL HH:mm");
}

/** ISO date string in Brisbane local — "2026-05-25". */
export function brisbaneDate(d: Date | string): string {
  const dt = typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d);
  return dt.setZone(ZONE).toISODate() ?? "";
}

/** Time-of-day in Brisbane as HH:mm. */
export function brisbaneTimeOfDay(d: Date | string): string {
  const dt = typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d);
  return dt.setZone(ZONE).toFormat("HH:mm");
}

/** Day-of-week in Brisbane: 1=Mon..7=Sun. */
export function brisbaneDayOfWeek(d: Date | string): number {
  const dt = typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d);
  return dt.setZone(ZONE).weekday;
}

/**
 * Whether a Date falls in the after-hours window in Brisbane local.
 * Window spec: `start` like "18:30", `end` like "07:00". Window wraps midnight
 * when start > end (the common case). Weekends are always after-hours.
 */
export function isAfterHours(d: Date | string, start: string, end: string): boolean {
  const dow = brisbaneDayOfWeek(d);
  if (dow === 6 || dow === 7) return true; // Sat/Sun

  const hhmm = brisbaneTimeOfDay(d);
  const [sH, sM] = start.split(":").map((x) => parseInt(x, 10));
  const [eH, eM] = end.split(":").map((x) => parseInt(x, 10));
  const [tH, tM] = hhmm.split(":").map((x) => parseInt(x, 10));

  const t = tH * 60 + tM;
  const s = sH * 60 + sM;
  const e = eH * 60 + eM;

  if (s === e) return false; // never
  if (s < e) {
    // Daytime window like 09:00-17:00 — after-hours = outside
    return t < s || t >= e;
  }
  // Wrapping window like 18:30 -> 07:00 — after-hours = t >= s OR t < e
  return t >= s || t < e;
}
