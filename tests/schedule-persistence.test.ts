import { describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { runMigrations } from '@/lib/db/migrate';
import { planEscalation } from '@/lib/engines/escalation';
import { deriveDoseTimes, DEFAULT_DAY_ANCHORS } from '@/lib/engines/instructions';
import type { MedicationCreateInput } from '@/lib/medications/validation';
import { createMedication } from '@/lib/medications/repository';
import {
  applyShift,
  listScheduleDoses,
  regenerateDaySchedule,
  transitionDose,
  type ScheduleDoseRecord,
} from '@/lib/schedules/repository';
import { getScheduleSettings } from '@/lib/schedules/settings';
import { createTestDb } from './helpers';

/** Fixed midday instant: the whole test day is 2026-09-17 (UTC demo day). */
const NOW = new Date('2026-09-17T12:00:00.000Z');

/** Find a dose by medication name, failing loudly instead of asserting on undefined. */
function doseByName(doses: ScheduleDoseRecord[], name: string): ScheduleDoseRecord {
  const dose = doses.find((candidate) => candidate.medicationName === name);
  if (!dose) throw new Error(`expected a persisted dose for ${name}`);
  return dose;
}

/** The PRD §4 worked-case pair, with RxNorm identities so buffers apply. */
function createWorkedCaseMeds(db: SqliteDb): void {
  const levothyroxine: MedicationCreateInput = {
    brandName: 'Synthroid',
    genericName: 'levothyroxine',
    dosage: '50 mcg',
    instructionsRaw: 'Take once daily in the morning on an empty stomach.',
    rxcui: '11289',
    highRiskSideEffects: [],
    source: 'ocr',
    extractionConfidence: 0.94,
    bufferType: null,
    minBufferMinutes: null,
  };
  const calcium: MedicationCreateInput = {
    brandName: 'Tums',
    genericName: 'calcium carbonate',
    dosage: '500 mg',
    instructionsRaw: 'Take once daily with breakfast.',
    rxcui: '21925',
    highRiskSideEffects: [],
    source: 'ocr',
    extractionConfidence: 0.91,
    bufferType: null,
    minBufferMinutes: null,
  };
  createMedication(db, DEMO_PROFILE_ID, levothyroxine);
  createMedication(db, DEMO_PROFILE_ID, calcium);
}

function seedDemoProfileRow(db: SqliteDb): void {
  db.prepare('INSERT INTO profiles (id, full_name, phone_encrypted) VALUES (?, ?, ?)').run(
    DEMO_PROFILE_ID,
    'Robert Sharma',
    'enc-not-under-test-here',
  );
}

describe('day-plan persistence — create → regenerate → reload (acceptance)', () => {
  it('derives doses from the medication list, persists them, and a fresh connection reads the same rows', () => {
    const { db, dbPath } = createTestDb();
    seedDemoProfileRow(db);
    createWorkedCaseMeds(db);

    const summary = regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);
    expect(summary.created).toBe(2);
    expect(summary.doses).toHaveLength(2);

    // Levothyroxine anchors on waking; calcium lands 2 h later (forward-only
    // buffer enforcement at generation time — 08:00 anchor violates the gap).
    const byName = new Map(summary.doses.map((dose) => [dose.medicationName, dose]));
    expect(byName.get('levothyroxine')?.scheduledFor).toBe('2026-09-17T07:00:00.000Z');
    const calciumDose = byName.get('calcium carbonate');
    expect(calciumDose?.scheduledFor).toBe('2026-09-17T09:00:00.000Z');
    expect(calciumDose?.deferredReason).toBe('buffer_push');
    expect(calciumDose?.adherenceStatus).toBe('PENDING');

    // "Reload": a second connection over the same SQLite file sees the
    // identical persisted plan — the schedule is server state, not client.
    const reopened = runMigrations(openDatabase(dbPath));
    const reloaded = listScheduleDoses(reopened, DEMO_PROFILE_ID);
    expect(reloaded).toEqual(summary.doses);
    reopened.close();
  });

  it('regeneration is idempotent — a second run changes nothing', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    createWorkedCaseMeds(db);

    regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);
    const second = regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);
    expect(second.created).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.doses).toHaveLength(2);
  });

  it('a resolved dose survives regeneration untouched', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    createWorkedCaseMeds(db);
    const { doses } = regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);

    const levo = doseByName(doses, 'levothyroxine');
    const confirmed = transitionDose(db, DEMO_PROFILE_ID, levo.id, 'confirm', NOW);
    expect(confirmed.kind).toBe('resolved');

    const after = regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);
    const stillThere = after.doses.find((dose) => dose.medicationName === 'levothyroxine');
    expect(stillThere?.adherenceStatus).toBe('CONFIRMED');
    expect(stillThere?.scheduledFor).toBe(levo.scheduledFor);
  });
});

describe('routine shift — "Woke up late" (PRD §4)', () => {
  it('the PRD worked case: wake 07:00 → 09:30 holds the 2 h levothyroxine/calcium gap by pushing calcium forward', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    createWorkedCaseMeds(db);
    regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);

    const shifted = applyShift(db, DEMO_PROFILE_ID, '09:30', NOW);
    expect(shifted.wakeDeltaMinutes).toBe(150);

    const byName = new Map(shifted.doses.map((dose) => [dose.medicationName, dose]));
    const levo = byName.get('levothyroxine');
    const calcium = byName.get('calcium carbonate');
    expect(levo?.scheduledFor).toBe('2026-09-17T09:30:00.000Z');
    expect(levo?.deferredReason).toBe('wake_shift');
    // 09:30 + 2 h = 11:30 — the shifted anchor (09:00 + 150 min) already meets
    // the gap exactly, so this solve displaced by wake shift, not by buffer.
    expect(calcium?.scheduledFor).toBe('2026-09-17T11:30:00.000Z');
    expect(calcium?.deferredReason).toBe('wake_shift');
    expect(shifted.hasBedtimeWarnings).toBe(false);
    expect(getScheduleSettings(db, DEMO_PROFILE_ID).wakeTime).toBe('09:30');
  });

  it('a confirmed dose is frozen — the shift re-enforces buffers around it', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    createWorkedCaseMeds(db);
    regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);
    const levo = doseByName(listScheduleDoses(db, DEMO_PROFILE_ID), 'levothyroxine');
    transitionDose(db, DEMO_PROFILE_ID, levo.id, 'confirm', NOW);

    const shifted = applyShift(db, DEMO_PROFILE_ID, '09:30', NOW);
    const byName = new Map(shifted.doses.map((dose) => [dose.medicationName, dose]));
    // Frozen: never rewritten, even by the wake delta.
    expect(byName.get('levothyroxine')?.scheduledFor).toBe('2026-09-17T07:00:00.000Z');
    expect(byName.get('levothyroxine')?.adherenceStatus).toBe('CONFIRMED');
    // Calcium's anchor is its persisted 09:00 (already buffer-pushed at
    // generation), so +150 min lands 11:30 — well clear of the frozen 07:00
    // levothyroxine. No push, no deferral beyond the wake shift.
    expect(byName.get('calcium carbonate')?.scheduledFor).toBe('2026-09-17T11:30:00.000Z');
    expect(byName.get('calcium carbonate')?.deferredReason).toBe('wake_shift');
  });

  it('a dose pushed past bedtime carries the gold warning', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    createMedication(db, DEMO_PROFILE_ID, {
      brandName: null,
      genericName: 'sertraline',
      dosage: '50 mg',
      instructionsRaw: 'Take once daily at bedtime.',
      rxcui: '82116',
      highRiskSideEffects: [],
      source: 'manual',
      extractionConfidence: null,
      bufferType: null,
      minBufferMinutes: null,
    });
    regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);

    // Wake 07:00 → 18:00 is +660 min: the 21:00 dose lands 08:00 next day.
    const shifted = applyShift(db, DEMO_PROFILE_ID, '18:00', NOW);
    expect(shifted.hasBedtimeWarnings).toBe(true);
    const sertraline = doseByName(shifted.doses, 'sertraline');
    expect(sertraline?.scheduledFor).toBe('2026-09-18T08:00:00.000Z');
    expect(sertraline?.isPastBedtimeWarning).toBe(true);
  });

  it('the next shift is relative to the persisted wake anchor', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    createWorkedCaseMeds(db);
    regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);

    applyShift(db, DEMO_PROFILE_ID, '09:30', NOW);
    const second = applyShift(db, DEMO_PROFILE_ID, '10:00', NOW);
    expect(second.wakeDeltaMinutes).toBe(30); // 09:30 → 10:00, not 07:00 → 10:00.
    const byName = new Map(second.doses.map((dose) => [dose.medicationName, dose]));
    expect(byName.get('levothyroxine')?.scheduledFor).toBe('2026-09-17T10:00:00.000Z');
    expect(byName.get('calcium carbonate')?.scheduledFor).toBe('2026-09-17T12:00:00.000Z');
  });
});

describe('dose transitions — UI mirror of the SMS lifecycle', () => {
  it('confirming a dose resolves it and cancels the pending escalation job', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    createWorkedCaseMeds(db);
    const { doses } = regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);
    const levo = doseByName(doses, 'levothyroxine');

    const job = planEscalation({ id: levo.id }, levo.scheduledFor);
    db
      .prepare(
        'INSERT INTO escalation_jobs (id, daily_schedule_id, profile_id, deliver_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('job-1', levo.id, DEMO_PROFILE_ID, job.deliverAt, 'pending');

    const outcome = transitionDose(db, DEMO_PROFILE_ID, levo.id, 'confirm', NOW);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(outcome.dose.adherenceStatus).toBe('CONFIRMED');
    expect(outcome.dose.confirmedAt).toBe(NOW.toISOString());

    const jobStatus = db
      .prepare('SELECT status FROM escalation_jobs WHERE id = ?')
      .get('job-1') as { status: string };
    expect(jobStatus.status).toBe('cancelled');
  });

  it('skipping resolves without a confirmed_at and resolves idempotently-adjacent states', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    createWorkedCaseMeds(db);
    const { doses } = regenerateDaySchedule(db, DEMO_PROFILE_ID, NOW);
    const calcium = doseByName(doses, 'calcium carbonate');

    const skipped = transitionDose(db, DEMO_PROFILE_ID, calcium.id, 'skip', NOW);
    expect(skipped.kind).toBe('resolved');
    if (skipped.kind !== 'resolved') return;
    expect(skipped.dose.adherenceStatus).toBe('SKIPPED');
    expect(skipped.dose.confirmedAt).toBeNull();

    // A skipped dose is frozen — confirming it is refused, not silently dropped.
    const lateConfirm = transitionDose(db, DEMO_PROFILE_ID, calcium.id, 'confirm', NOW);
    expect(lateConfirm).toMatchObject({ kind: 'not_transitionable', current: 'SKIPPED' });
  });

  it('a missing dose reports not_found', () => {
    const { db } = createTestDb();
    seedDemoProfileRow(db);
    expect(transitionDose(db, DEMO_PROFILE_ID, 'no-such-row', 'confirm', NOW)).toEqual({
      kind: 'not_found',
    });
  });
});

describe('dose-time derivation — instructions parser seams', () => {
  it('maps the common label phrasings to the day anchors', () => {
    expect(deriveDoseTimes('Take once daily in the morning on an empty stomach.')).toEqual([
      DEFAULT_DAY_ANCHORS.wake,
    ]);
    expect(deriveDoseTimes('Take once daily with breakfast.')).toEqual([DEFAULT_DAY_ANCHORS.breakfast]);
    expect(deriveDoseTimes('Take once daily at bedtime.')).toEqual([DEFAULT_DAY_ANCHORS.bedtimeDose]);
    expect(deriveDoseTimes('Take twice daily with food.')).toEqual([
      DEFAULT_DAY_ANCHORS.breakfast,
      DEFAULT_DAY_ANCHORS.dinner,
    ]);
  });

  it('intervals step from wake and stop at the bedtime-dose anchor', () => {
    expect(deriveDoseTimes('Take one capsule every 6 hours.')).toEqual(['07:00', '13:00', '19:00']);
  });

  it('unrecognized text falls back to a single wake-anchored dose', () => {
    expect(deriveDoseTimes('Take as directed by your physician.')).toEqual([DEFAULT_DAY_ANCHORS.wake]);
  });
});
