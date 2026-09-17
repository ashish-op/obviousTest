/**
 * Earliest-pending-dose resolution (PRD §5 risk: concurrent doses).
 *
 * The two-way SMS state machine must know which dose an inbound "1"/"YES"
 * confirms. Rule from the build spec: when several doses are confirmable at
 * once, the EARLIEST-SCHEDULED pending row wins, with a deterministic id
 * tie-break for exact ties.
 */

import type { AdherenceStatus, DoseEvent } from './types';
import { toInstant } from './time';
import { canonicalizeSymptomKeyword } from './risk-matrix';

/**
 * Statuses that can still be confirmed by an inbound SMS. ESCALATED counts:
 * a caregiver-notified dose is still awaiting the patient's confirmation.
 */
const CONFIRMABLE_STATUSES: ReadonlySet<AdherenceStatus> = new Set(['PENDING', 'ESCALATED']);

/**
 * One parsed inbound SMS (PRD §5 protocol). A discriminated union so the
 * webhook handler can never conflate a dose confirmation with a symptom
 * report, and `unknown` is a value rather than an exception.
 */
export type InboundCommand =
  | { kind: 'confirm' }
  | { kind: 'skip' }
  | { kind: 'symptom_report'; canonicalSymptom: string; affirmed: boolean }
  | { kind: 'unknown' };

/** Confirmation keywords (PRD §5): replies that confirm the resolved dose. */
const CONFIRM_KEYWORDS: ReadonlySet<string> = new Set(['1', 'YES', 'CONFIRMED']);
/** Denial keywords that mark the dose skipped. */
const SKIP_KEYWORDS: ReadonlySet<string> = new Set(['NO', 'SKIP', 'SKIPPED']);

/**
 * Parse one inbound SMS body into a protocol command (PRD §5):
 * `1`/`YES`/`CONFIRMED` confirm; `DIZZY YES`/`DIZZY NO` are symptom reports;
 * unrecognized text is `unknown`, never a guess.
 */
export function parseInboundCommand(body: string): InboundCommand {
  const text = body.trim().toUpperCase();
  if (CONFIRM_KEYWORDS.has(text)) return { kind: 'confirm' };
  if (SKIP_KEYWORDS.has(text)) return { kind: 'skip' };

  // `<SYMPTOM> YES|NO` — the DIZZY YES / DIZZY NO protocol.
  const [keyword, answer, ...rest] = text.split(/\s+/);
  if (keyword !== undefined && answer !== undefined && rest.length === 0 && (answer === 'YES' || answer === 'NO')) {
    const canonicalSymptom = canonicalizeSymptomKeyword(keyword);
    if (canonicalSymptom) return { kind: 'symptom_report', canonicalSymptom, affirmed: answer === 'YES' };
  }

  return { kind: 'unknown' };
}

/**
 * Resolve the dose an inbound confirmation applies to.
 * Returns null when nothing is confirmable — the webhook replies "no pending dose".
 * Deterministic: input order never affects the result.
 */
export function resolveEarliestPendingDose<T extends Pick<DoseEvent, 'id' | 'scheduledFor' | 'adherenceStatus'>>(
  doses: readonly T[],
): T | null {
  const confirmable = doses
    .filter((dose) => CONFIRMABLE_STATUSES.has(dose.adherenceStatus))
    .sort(
      (a, b) =>
        toInstant(a.scheduledFor).getTime() - toInstant(b.scheduledFor).getTime() ||
        a.id.localeCompare(b.id),
    );
  return confirmable[0] ?? null;
}
