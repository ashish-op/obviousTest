/**
 * Pure time helpers for the engines. Everything is an absolute ISO-8601
 * instant — the same TEXT format SQLite stores (strftime('%Y-%m-%dT%H:%M:%fZ')).
 * No local-time parsing anywhere: callers convert wall-clock input to instants
 * before invoking an engine, keeping the functions deterministic and DST-proof.
 */

const MINUTE_MS = 60_000;

/** Parse an ISO-8601 instant, failing loudly on garbage instead of returning NaN. */
export function toInstant(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Not a valid ISO-8601 timestamp: "${iso}"`);
  }
  return d;
}

export function toIso(date: Date): string {
  return date.toISOString();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function diffMinutes(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MINUTE_MS;
}
