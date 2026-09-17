/**
 * Escalation engine (PRD §5) + dose lifecycle transitions.
 *
 * The 45-minute caregiver escalation is planned here as pure timing math and
 * dispatched later by the in-process sweep over durable `escalation_jobs`
 * rows. Tests inject a fixed clock by passing an explicit `now: Date`.
 */

import type { AdherenceStatus, DoseEvent, EscalationJobView } from './types';
import { addMinutes, toInstant, toIso } from './time';

/** PRD §5: an unconfirmed dose escalates to the caregiver 45 minutes after its scheduled time. */
export const ESCALATION_DELAY_MINUTES = 45;

/**
 * When the caregiver escalation for an unconfirmed dose fires:
 * `scheduledFor + ESCALATION_DELAY_MINUTES` — the "missed dose at 3 PM" case
 * escalates at 3:45 PM.
 */
export function computeEscalationDeliverAt(scheduledFor: string): Date {
  return addMinutes(toInstant(scheduledFor), ESCALATION_DELAY_MINUTES);
}

/** Plan an escalation job for a dose — the row the caller persists into `escalation_jobs`. */
export function planEscalation(
  dose: Pick<DoseEvent, 'id'>,
  scheduledFor: string,
): { dailyScheduleId: string; deliverAt: string } {
  return {
    dailyScheduleId: dose.id,
    deliverAt: toIso(computeEscalationDeliverAt(scheduledFor)),
  };
}

/**
 * Whether an unconfirmed dose has passed its escalation window at `now`
 * (injected clock — never `Date.now()` inside the engine).
 */
export function shouldEscalateDose(
  dose: Pick<DoseEvent, 'adherenceStatus' | 'scheduledFor'>,
  now: Date,
): boolean {
  if (dose.adherenceStatus !== 'PENDING') return false;
  return now.getTime() >= computeEscalationDeliverAt(dose.scheduledFor).getTime();
}

/**
 * Sweep selection: pending jobs whose `deliverAt` has arrived at `now`, in
 * dispatch order (deliverAt ascending, id tie-break). Dispatching and status
 * writes happen in the sweep runner; this is the pure decision.
 */
export function selectDueEscalations<T extends EscalationJobView>(
  jobs: readonly T[],
  now: Date,
): T[] {
  return jobs
    .filter((job) => job.status === 'pending' && toInstant(job.deliverAt).getTime() <= now.getTime())
    .sort(
      (a, b) =>
        toInstant(a.deliverAt).getTime() - toInstant(b.deliverAt).getTime() || a.id.localeCompare(b.id),
    );
}

/**
 * Dose lifecycle transitions (PRD §2 enum `PENDING → CONFIRMED | ESCALATED | SKIPPED`).
 * `confirm` covers the SMS keywords 1 / YES / CONFIRMED; an escalated dose may
 * still be confirmed late. Returns null for invalid transitions — callers must
 * not silently drop the null.
 */
export function nextDoseStatus(
  current: AdherenceStatus,
  command: 'confirm' | 'skip',
): AdherenceStatus | null {
  switch (command) {
    case 'confirm':
      switch (current) {
        case 'PENDING':
        case 'ESCALATED':
          return 'CONFIRMED';
        case 'CONFIRMED':
          return 'CONFIRMED'; // Idempotent re-confirmation.
        case 'SKIPPED':
          return null; // A skipped dose cannot be confirmed.
      }
      break;
    case 'skip':
      switch (current) {
        case 'PENDING':
        case 'ESCALATED':
          return 'SKIPPED';
        default:
          return null; // Resolved doses are frozen.
      }
  }
}
