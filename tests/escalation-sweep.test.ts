/**
 * Escalation sweep tests with an injected fixed clock (build spec verification
 * table: "Unconfirmed dose escalates to caregiver after 45 min" — job enqueued
 * at +45, sweep advances, caregiver message lands in sms_outbox, dose flips to
 * ESCALATED; failure modes: fires early, late beyond the sweep interval, or
 * not at all).
 *
 * Fixture adapters only — CI can never send. No setTimeout: the clock is a
 * constructor argument and every boundary is asserted exactly.
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAdapters } from '@/lib/adapters';
import { encryptPhoneNumber, decryptPhoneNumber } from '@/lib/crypto/phone-crypto';
import { enqueueDoseEscalation } from '@/lib/telephony/escalation-scheduler';
import { ensureEscalationJobs, runEscalationSweep } from '@/lib/telephony/sweep';
import { createPendingSchedule, createTestDb, TEST_KEY_HEX } from './helpers';
import type { SqliteDb } from '@/lib/db/connection';

const KEY = Buffer.from(TEST_KEY_HEX, 'hex');
const SCHEDULED_AT = '2026-09-17T08:00:00.000Z';
const DUE_AT = '2026-09-17T08:45:00.000Z'; // exactly +45 minutes
const CAREGIVER_PHONE = '+15550002222';

function fixtureAdapters(db: SqliteDb) {
  // No TWILIO_* keys — the factory must resolve the fixture bundle.
  return getAdapters({ NODE_ENV: 'test', PHONE_ENCRYPTION_KEY: TEST_KEY_HEX }, { db });
}

interface EscalationFixture {
  db: SqliteDb;
  profileId: string;
  scheduleId: string;
}

/** Patient + caregiver + one PENDING dose, ready for escalation scheduling. */
function seedDoseWithCaregiver(scheduledFor: string = SCHEDULED_AT): EscalationFixture {
  const { db } = createTestDb();
  const { profileId, scheduleId } = createPendingSchedule(db, scheduledFor);
  db.prepare(
    'UPDATE profiles SET full_name = ?, caregiver_name = ?, caregiver_phone_encrypted = ? WHERE id = ?',
  ).run('Escalation Patient', 'Care Person', encryptPhoneNumber(CAREGIVER_PHONE, KEY), profileId);
  return { db, profileId, scheduleId };
}

function outboxMessages(db: SqliteDb): { to: string; body: string }[] {
  return (
    db
      .prepare(
        `SELECT recipient_encrypted, body FROM sms_outbox WHERE direction = 'outbound' ORDER BY rowid`,
      )
      .all() as { recipient_encrypted: string; body: string }[]
  ).map((row) => ({
    to: decryptPhoneNumber(row.recipient_encrypted, KEY),
    body: row.body,
  }));
}

function doseRow(db: SqliteDb, scheduleId: string) {
  return db
    .prepare('SELECT adherence_status, escalated_at FROM daily_schedules WHERE id = ?')
    .get(scheduleId) as { adherence_status: string; escalated_at: string | null };
}

function jobRow(db: SqliteDb, scheduleId: string) {
  return db
    .prepare('SELECT id, deliver_at, status, dispatched_at FROM escalation_jobs WHERE daily_schedule_id = ?')
    .get(scheduleId) as {
    id: string;
    deliver_at: string;
    status: 'pending' | 'dispatched' | 'cancelled';
    dispatched_at: string | null;
  };
}

describe('enqueueDoseEscalation — +45-minute plan through the delay queue', () => {
  it('enqueues a durable job due exactly at scheduledFor + 45 minutes', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const { delayQueue } = fixtureAdapters(db);

    const result = await enqueueDoseEscalation(
      delayQueue,
      { id: scheduleId, scheduledFor: SCHEDULED_AT },
      profileId,
    );

    expect(result.deliverAt).toBe(DUE_AT);
    const job = jobRow(db, scheduleId);
    expect(job.status).toBe('pending');
    expect(job.deliver_at).toBe(DUE_AT);
    expect(job.dispatched_at).toBeNull();
  });
});

describe('runEscalationSweep — fixed-clock dispatch semantics', () => {
  it('does not dispatch before the window closes (fires early = failure)', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const adapters = fixtureAdapters(db);
    await enqueueDoseEscalation(adapters.delayQueue, { id: scheduleId, scheduledFor: SCHEDULED_AT }, profileId);

    const outcome = await runEscalationSweep(
      db,
      adapters,
      KEY,
      new Date('2026-09-17T08:44:59.999Z'), // one millisecond early
    );

    expect(outcome.dispatchedJobs).toBe(0);
    expect(outboxMessages(db)).toHaveLength(0);
    expect(doseRow(db, scheduleId).adherence_status).toBe('PENDING');
    expect(jobRow(db, scheduleId).status).toBe('pending');
  });

  it('dispatches the caregiver SMS exactly at +45 and marks the dose ESCALATED', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const adapters = fixtureAdapters(db);
    await enqueueDoseEscalation(adapters.delayQueue, { id: scheduleId, scheduledFor: SCHEDULED_AT }, profileId);

    const outcome = await runEscalationSweep(db, adapters, KEY, new Date(DUE_AT));

    expect(outcome.dispatchedJobs).toBe(1);
    expect(outcome.escalatedScheduleIds).toEqual([scheduleId]);

    const messages = outboxMessages(db);
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe(CAREGIVER_PHONE);
    expect(messages[0].body).toContain("hasn't been confirmed after 45 minutes");
    expect(messages[0].body).toContain('Escalation Patient');

    const dose = doseRow(db, scheduleId);
    expect(dose.adherence_status).toBe('ESCALATED');
    expect(dose.escalated_at).not.toBeNull();
    const job = jobRow(db, scheduleId);
    expect(job.status).toBe('dispatched');
    expect(job.dispatched_at).toBe(DUE_AT);
  });

  it('is idempotent — a second sweep at the same instant sends nothing more', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const adapters = fixtureAdapters(db);
    await enqueueDoseEscalation(adapters.delayQueue, { id: scheduleId, scheduledFor: SCHEDULED_AT }, profileId);
    await runEscalationSweep(db, adapters, KEY, new Date(DUE_AT));

    const second = await runEscalationSweep(db, adapters, KEY, new Date(DUE_AT));

    expect(second.dispatchedJobs).toBe(0);
    expect(outboxMessages(db)).toHaveLength(1); // still exactly one caregiver SMS
  });

  it('cancels the job without paging the caregiver when the dose was resolved meanwhile', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const adapters = fixtureAdapters(db);
    await enqueueDoseEscalation(adapters.delayQueue, { id: scheduleId, scheduledFor: SCHEDULED_AT }, profileId);
    // The patient confirmed through the webhook between enqueue and dispatch.
    db.prepare(
      `UPDATE daily_schedules SET adherence_status = 'CONFIRMED', confirmed_at = ? WHERE id = ?`,
    ).run('2026-09-17T08:10:00.000Z', scheduleId);

    const outcome = await runEscalationSweep(db, adapters, KEY, new Date('2026-09-17T09:00:00.000Z'));

    expect(outcome.dispatchedJobs).toBe(0);
    expect(outcome.cancelledJobs).toBe(1);
    expect(outboxMessages(db)).toHaveLength(0); // the caregiver never hears about a handled dose
    expect(doseRow(db, scheduleId).adherence_status).toBe('CONFIRMED');
    expect(jobRow(db, scheduleId).status).toBe('cancelled');
  });

  it('backfills a missing job and dispatches it in the same tick (restart-safe)', async () => {
    const { db, scheduleId } = seedDoseWithCaregiver();
    const adapters = fixtureAdapters(db);
    // No job was ever enqueued (dosing app died after insert, say). The sweep
    // clock is already 15 minutes past the window.

    const outcome = await runEscalationSweep(db, adapters, KEY, new Date('2026-09-17T09:00:00.000Z'));

    expect(outcome.backfilledJobs).toBe(1);
    expect(outcome.dispatchedJobs).toBe(1);
    expect(outboxMessages(db)).toHaveLength(1);
    expect(doseRow(db, scheduleId).adherence_status).toBe('ESCALATED');
    // The backfilled job still carries the engine's exact +45 window.
    expect(jobRow(db, scheduleId).deliver_at).toBe(DUE_AT);
  });

  it('backfill does not duplicate jobs for doses that already have one', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const adapters = fixtureAdapters(db);
    await enqueueDoseEscalation(adapters.delayQueue, { id: scheduleId, scheduledFor: SCHEDULED_AT }, profileId);

    const outcome = await runEscalationSweep(db, adapters, KEY, new Date(DUE_AT));

    expect(outcome.backfilledJobs).toBe(0);
    const jobs = db
      .prepare('SELECT COUNT(*) AS n FROM escalation_jobs WHERE daily_schedule_id = ?')
      .get(scheduleId) as { n: number };
    expect(jobs.n).toBe(1);
  });

  it('dispatches multiple due escalations in deliverAt order (deterministic sweep)', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const lateScheduleId = crypto.randomUUID();
    const lateMedId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO medications (id, profile_id, generic_name, dosage, instructions_raw) VALUES (?, ?, 'Metformin', '500 mg', 'With meals.')`,
    ).run(lateMedId, profileId);
    db.prepare(
      'INSERT INTO daily_schedules (id, profile_id, medication_id, scheduled_for) VALUES (?, ?, ?, ?)',
    ).run(lateScheduleId, profileId, lateMedId, '2026-09-17T09:00:00.000Z');

    const adapters = fixtureAdapters(db);
    await enqueueDoseEscalation(adapters.delayQueue, { id: scheduleId, scheduledFor: SCHEDULED_AT }, profileId);
    await enqueueDoseEscalation(
      adapters.delayQueue,
      { id: lateScheduleId, scheduledFor: '2026-09-17T09:00:00.000Z' },
      profileId,
    );

    const outcome = await runEscalationSweep(db, adapters, KEY, new Date('2026-09-17T09:45:00.000Z'));

    expect(outcome.dispatchedJobs).toBe(2);
    const messages = outboxMessages(db);
    expect(messages).toHaveLength(2);
    expect(messages[0].body).toContain('08:00'); // due 08:45 first
    expect(messages[1].body).toContain('09:00'); // due 09:45 second
  });

  it('still escalates the dose when no caregiver is configured (no channel, no SMS)', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const adapters = fixtureAdapters(db);
    await enqueueDoseEscalation(adapters.delayQueue, { id: scheduleId, scheduledFor: SCHEDULED_AT }, profileId);
    db.prepare('UPDATE profiles SET caregiver_phone_encrypted = NULL WHERE id = ?').run(profileId);

    const outcome = await runEscalationSweep(db, adapters, KEY, new Date(DUE_AT));

    expect(outcome.dispatchedJobs).toBe(1);
    expect(outboxMessages(db)).toHaveLength(0);
    expect(doseRow(db, scheduleId).adherence_status).toBe('ESCALATED');
  });

  it('ensure pass plans future doses without dispatching anything (nothing due yet)', async () => {
    const { db, profileId, scheduleId } = seedDoseWithCaregiver();
    const adapters = fixtureAdapters(db);
    // A second, later dose for the same patient — not yet due.
    const futureDose = crypto.randomUUID();
    const futureMed = crypto.randomUUID();
    db.prepare(
      `INSERT INTO medications (id, profile_id, generic_name, dosage, instructions_raw) VALUES (?, ?, 'Amlodipine', '5 mg', 'Once daily.')`,
    ).run(futureMed, profileId);
    db.prepare(
      'INSERT INTO daily_schedules (id, profile_id, medication_id, scheduled_for) VALUES (?, ?, ?, ?)',
    ).run(futureDose, profileId, futureMed, '2026-09-17T20:00:00.000Z');

    const backfilled = await ensureEscalationJobs(db, adapters.delayQueue);

    expect(backfilled).toBe(2); // both pending doses get their +45 plan
    const futureJob = db
      .prepare('SELECT deliver_at, status FROM escalation_jobs WHERE daily_schedule_id = ?')
      .get(futureDose) as { deliver_at: string; status: string };
    expect(futureJob.deliver_at).toBe('2026-09-17T20:45:00.000Z');
    expect(futureJob.status).toBe('pending');
    expect(outboxMessages(db)).toHaveLength(0); // nothing due — no dispatch
  });
});
