/**
 * Wall-clock ↔ instant helpers for the schedule module.
 *
 * This build runs the demo day entirely in UTC: dose times are stored as
 * absolute ISO instants built from UTC HH:MM anchors, so no timezone math
 * happens anywhere else (documented demo simplification — the Supabase phase
 * introduces per-profile timezones).
 */

/** Strict HH:MM wall clock, 00:00–23:59. */
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHhMmClock(value: unknown): value is string {
  return typeof value === 'string' && HH_MM.test(value);
}

/** UTC calendar date (YYYY-MM-DD) of an instant. */
export function dayIsoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The absolute ISO instant of an HH:MM clock on a UTC day. */
export function clockInstant(dayIso: string, clock: string): string {
  if (!isHhMmClock(clock)) {
    throw new RangeError(`clock must be HH:MM (00:00–23:59), got "${clock}"`);
  }
  return `${dayIso}T${clock}:00.000Z`;
}

/** The HH:MM wall clock of an ISO instant (UTC slice, demo convention). */
export function instantClock(iso: string): string {
  return iso.slice(11, 16);
}
