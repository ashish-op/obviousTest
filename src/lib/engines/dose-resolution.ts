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

/**
 * Statuses that can still be confirmed by an inbound SMS. ESCALATED counts:
 * a caregiver-notified dose is still awaiting the patient's confirmation.
 */
const CONFIRMABLE_STATUSES: ReadonlySet<AdherenceStatus> = new Set(['PENDING', 'ESCALATED']);

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
