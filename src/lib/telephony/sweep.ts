/**
 * Escalation sweep (build spec: "escalation timing is an in-process sweep over
 * durable `escalation_jobs` rows, dispatched on a fixed interval with clock
 * injection").
 *
 * One tick = ensure + dispatch:
 *   1. ENSURE — every still-PENDING dose without an active escalation job gets
 *      one at scheduledFor + 45 min (durable, restart-safe: a dose that slipped
 *      through without a job is backfilled here, so "unconfirmed doses
 *      escalate" cannot be lost to a missed enqueue).
 *   2. DISPATCH — due jobs send the caregiver notice through the
 *      SmsGatewayAdapter, mark the dose ESCALATED, and close the job.
 *
 * Doses resolved (confirmed/skipped) between enqueue and dispatch cancel
 * their job instead — the caregiver never hears about a handled dose.
 * Dispatch order is deliverAt-ascending (engine `selectDueEscalations`).
 * No setTimeout anywhere: the tick is idempotent and fully deterministic
 * under an injected clock.
 */

import type { SqliteDb } from '@/lib/db/connection';
import { decryptPhoneNumber } from '@/lib/crypto/phone-crypto';
import type { Adapters, DelayQueueAdapter } from '@/lib/adapters/types';
import { selectDueEscalations } from '@/lib/engines/escalation';
import type { EscalationJobView } from '@/lib/engines/types';
import { caregiverEscalationMessage } from './messages';
import { enqueueDoseEscalation } from './escalation-scheduler';

export interface SweepOutcome {
  /** Pending doses with no active job that got one (ensure pass). */
  backfilledJobs: number;
  /** Due jobs whose caregiver notice was sent and dose marked ESCALATED. */
  dispatchedJobs: number;
  /** Due jobs closed because the dose was resolved meanwhile (no SMS sent). */
  cancelledJobs: number;
  escalatedScheduleIds: string[];
}

interface DueJobRow extends EscalationJobView {
  daily_schedule_id: string;
}

interface DoseContextRow {
  id: string;
  adherence_status: string;
  scheduled_for: string;
  medication_generic_name: string;
  profile_full_name: string;
  profile_caregiver_phone_encrypted: string | null;
}

/**
 * Run one sweep tick at `now` (injected clock; the route passes `new Date()`).
 * The adapter bundle supplies both queues: `delayQueue` for the ensure pass,
 * `smsGateway` for caregiver dispatch.
 */
export async function runEscalationSweep(
  db: SqliteDb,
  adapters: Pick<Adapters, 'smsGateway' | 'delayQueue'>,
  encryptionKey: Buffer,
  now: Date,
): Promise<SweepOutcome> {
  const backfilledJobs = await ensureEscalationJobs(db, adapters.delayQueue);

  const dueRows = db
    .prepare('SELECT id, daily_schedule_id, deliver_at, status FROM escalation_jobs WHERE status = ?')
    .all('pending') as DueJobRow[];
  const due = selectDueEscalations(dueRows, now);

  let dispatchedJobs = 0;
  let cancelledJobs = 0;
  const escalatedScheduleIds: string[] = [];

  for (const job of due) {
    const dose = loadDoseContext(db, job.daily_schedule_id);

    if (!dose || dose.adherence_status !== 'PENDING') {
      // Resolved while the job sat pending (or the dose row vanished) — close
      // the job quietly; the caregiver never hears about a handled dose.
      db.prepare(`UPDATE escalation_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
      cancelledJobs += 1;
      continue;
    }

    const caregiverPhone = dose.profile_caregiver_phone_encrypted
      ? decryptPhoneNumber(dose.profile_caregiver_phone_encrypted, encryptionKey)
      : null;

    if (caregiverPhone) {
      await adapters.smsGateway.send(
        caregiverPhone,
        caregiverEscalationMessage({
          patientName: dose.profile_full_name,
          medicationName: dose.medication_generic_name,
          scheduledFor: dose.scheduled_for,
        }),
      );
    }
    // No caregiver configured: the escalation still resolves — the dose is
    // marked ESCALATED so the app surfaces it, with no channel to send to.

    db.prepare(
      `UPDATE escalation_jobs SET status = 'dispatched', attempts = attempts + 1, dispatched_at = ? WHERE id = ?`,
    ).run(now.toISOString(), job.id);
    db.prepare(
      `UPDATE daily_schedules SET adherence_status = 'ESCALATED', escalated_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), dose.id);

    dispatchedJobs += 1;
    escalatedScheduleIds.push(dose.id);
  }

  return { backfilledJobs, dispatchedJobs, cancelledJobs, escalatedScheduleIds };
}

/**
 * ENSURE pass: backfill escalation jobs for still-pending doses that have no
 * active (pending or dispatched) job, with the engine's exact +45 window as
 * deliver_at. Idempotent — the normal path enqueues at dose creation, so this
 * inserts nothing; it only heals gaps (missed enqueues, demo doses).
 */
export async function ensureEscalationJobs(
  db: SqliteDb,
  delayQueue: DelayQueueAdapter,
): Promise<number> {
  const unqueued = db
    .prepare(
      `SELECT s.id, s.profile_id, s.scheduled_for
       FROM daily_schedules s
       WHERE s.adherence_status = 'PENDING'
         AND NOT EXISTS (
           SELECT 1 FROM escalation_jobs j
           WHERE j.daily_schedule_id = s.id AND j.status IN ('pending', 'dispatched')
         )`,
    )
    .all() as { id: string; profile_id: string; scheduled_for: string }[];

  for (const dose of unqueued) {
    await enqueueDoseEscalation(delayQueue, { id: dose.id, scheduledFor: dose.scheduled_for }, dose.profile_id);
  }
  return unqueued.length;
}

function loadDoseContext(db: SqliteDb, scheduleId: string): DoseContextRow | undefined {
  return db
    .prepare(
      `SELECT s.id, s.adherence_status, s.scheduled_for,
              m.generic_name AS medication_generic_name,
              p.full_name AS profile_full_name,
              p.caregiver_phone_encrypted AS profile_caregiver_phone_encrypted
       FROM daily_schedules s
       JOIN medications m ON m.id = s.medication_id
       JOIN profiles p ON p.id = s.profile_id
       WHERE s.id = ?`,
    )
    .get(scheduleId) as DoseContextRow | undefined;
}
