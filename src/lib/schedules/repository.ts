/**
 * Schedule persistence — `daily_schedules` reads/writes for the demo
 * profile, with the solver as the single source of placement semantics.
 *
 * Two operations, both solver-backed:
 *
 * - `regenerateDaySchedule` — sync the day's dose rows with the medication
 *   list. Existing rows keep their current times as anchors (a previous
 *   wake shift is part of the plan, not something to un-do); derived slots
 *   with no matching row become new PENDING doses; unresolved rows beyond
 *   the derived slot count are removed; resolved rows are frozen facts and
 *   never touched. The solver then runs with a zero wake delta, so the only
 *   displacement it applies is forward buffer enforcement against current
 *   anchors. Idempotent: a second run reproduces the same rows.
 * - `applyShift` — the PRD §4 "Woke up late" flow: every unresolved row
 *   moves by the clamped wake delta, buffers re-enforce forward-only around
 *   frozen doses, past-bedtime flags recompute, and the new wake anchor
 *   persists so the next shift is relative to it.
 *
 * Dose-status transitions mirror the SMS loop's (PENDING/ESCALATED →
 * CONFIRMED/SKIPPED via the shared engine) and, like it, cancel any pending
 * escalation job for the resolved dose.
 */

import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';
import { nextDoseStatus } from '@/lib/engines/escalation';
import { DEFAULT_DAY_ANCHORS } from '@/lib/engines/instructions';
import { buildBufferRequirements } from '@/lib/engines/rxnorm';
import { recalculateDynamicSchedule } from '@/lib/engines/schedule-solver';
import type { AdherenceStatus, DoseEvent, DeferredReason } from '@/lib/engines/types';
import { listMedications } from '@/lib/medications/repository';
import { clockInstant, dayIsoOf, isHhMmClock } from './clock';
import { deriveSlots, slotEvent } from './generator';
import { getScheduleSettings, updateScheduleSettings } from './settings';

export interface ScheduleDoseRecord {
  id: string;
  medicationId: string;
  medicationName: string;
  brandName: string | null;
  dosage: string;
  scheduledFor: string;
  adherenceStatus: AdherenceStatus;
  deferredReason: DeferredReason | null;
  isPastBedtimeWarning: boolean;
  confirmedAt: string | null;
  escalatedAt: string | null;
}

interface ScheduleRow {
  id: string;
  medication_id: string;
  scheduled_for: string;
  adherence_status: string;
  deferred_reason: string | null;
  is_past_bedtime_warning: number;
  confirmed_at: string | null;
  escalated_at: string | null;
  generic_name: string;
  brand_name: string | null;
  dosage: string;
}

const FROZEN_STATUSES: ReadonlySet<string> = new Set(['CONFIRMED', 'SKIPPED']);

function deferredReasonOf(value: string | null): DeferredReason | null {
  return value === 'buffer_push' || value === 'wake_shift' ? value : null;
}

function toRecord(row: ScheduleRow): ScheduleDoseRecord {
  return {
    id: row.id,
    medicationId: row.medication_id,
    medicationName: row.generic_name,
    brandName: row.brand_name,
    dosage: row.dosage,
    scheduledFor: row.scheduled_for,
    adherenceStatus: row.adherence_status as AdherenceStatus,
    deferredReason: deferredReasonOf(row.deferred_reason),
    isPastBedtimeWarning: row.is_past_bedtime_warning === 1,
    confirmedAt: row.confirmed_at,
    escalatedAt: row.escalated_at,
  };
}

function rowEvent(row: ScheduleRow): DoseEvent {
  return {
    id: row.id,
    medicationId: row.medication_id,
    scheduledFor: row.scheduled_for,
    adherenceStatus: row.adherence_status as AdherenceStatus,
    isPastBedtimeWarning: row.is_past_bedtime_warning === 1,
    deferredReason: deferredReasonOf(row.deferred_reason),
  };
}

function loadScheduleRows(db: SqliteDb, profileId: string): ScheduleRow[] {
  return db
    .prepare(
      `SELECT s.id, s.medication_id, s.scheduled_for, s.adherence_status, s.deferred_reason,
              s.is_past_bedtime_warning, s.confirmed_at, s.escalated_at,
              m.generic_name, m.brand_name, m.dosage
         FROM daily_schedules s
         JOIN medications m ON m.id = s.medication_id
        WHERE s.profile_id = ?
        ORDER BY s.scheduled_for, s.id`,
    )
    .all(profileId) as ScheduleRow[];
}

/** The demo profile's dose rows, render-ordered by scheduled time. */
export function listScheduleDoses(db: SqliteDb, profileId: string): ScheduleDoseRecord[] {
  return loadScheduleRows(db, profileId).map(toRecord);
}

export function getScheduleDose(
  db: SqliteDb,
  profileId: string,
  scheduleId: string,
): ScheduleDoseRecord | null {
  const row = loadScheduleRows(db, profileId).find((candidate) => candidate.id === scheduleId);
  return row ? toRecord(row) : null;
}

export interface RegenerateSummary {
  created: number;
  removed: number;
  updated: number;
  doses: ScheduleDoseRecord[];
}

/**
 * Sync the day's dose rows with the medication list (semantics in the module
 * header). Runs inside one transaction; returns the fresh render-ordered list.
 */
export function regenerateDaySchedule(
  db: SqliteDb,
  profileId: string,
  now: Date,
): RegenerateSummary {
  const medications = listMedications(db, profileId);
  const settings = getScheduleSettings(db, profileId);
  const rows = loadScheduleRows(db, profileId);
  const dayIso = dayIsoOf(now);

  // Reconcile rows against derived slots, per medication: rows (any status)
  // in time order zip slot-by-slot; extras beyond the slot count are removed
  // when unresolved (frozen rows are history — they survive), and slots
  // beyond the row count become new PENDING events.
  const keptRows: ScheduleRow[] = [];
  const createdSlots: DoseEvent[] = [];
  const removedIds: string[] = [];

  const slots = deriveSlots(medications, DEFAULT_DAY_ANCHORS);
  for (const medication of medications) {
    const medSlots = slots.filter((slot) => slot.medicationId === medication.id);
    const medRows = rows.filter((row) => row.medication_id === medication.id);
    medRows.forEach((row, index) => {
      if (index < medSlots.length || FROZEN_STATUSES.has(row.adherence_status)) {
        keptRows.push(row);
      } else {
        removedIds.push(row.id);
      }
    });
    for (let index = medRows.length; index < medSlots.length; index += 1) {
      createdSlots.push(
        slotEvent(medSlots[index], dayIso, `slot:${medication.id}:${medSlots[index].clock}`),
      );
    }
  }

  const result = recalculateDynamicSchedule({
    doses: [...keptRows.map(rowEvent), ...createdSlots],
    oldWakeTime: clockInstant(dayIso, settings.wakeTime),
    // Zero delta: regeneration re-enforces buffers against current anchors
    // and recomputes bedtime flags; it never re-applies a wake shift.
    newWakeTime: clockInstant(dayIso, settings.wakeTime),
    bedtime: clockInstant(dayIso, settings.bedtime),
    bufferRequirements: buildBufferRequirements(medications),
  });

  const transitionAt = now.toISOString();
  let created = 0;
  let updated = 0;
  const apply = db.transaction(() => {
    for (const dose of result.doses) {
      if (dose.frozen) continue;

      if (dose.id.startsWith('slot:')) {
        db.prepare(
          `INSERT INTO daily_schedules
             (id, profile_id, medication_id, scheduled_for, adherence_status,
              deferred_reason, is_past_bedtime_warning)
           VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        ).run(
          randomUUID(),
          profileId,
          dose.medicationId,
          dose.newScheduledFor,
          dose.deferredReason,
          dose.isPastBedtimeWarning ? 1 : 0,
        );
        created += 1;
        continue;
      }

      const before = keptRows.find((row) => row.id === dose.id);
      if (
        before &&
        before.scheduled_for === dose.newScheduledFor &&
        before.deferred_reason === dose.deferredReason &&
        (before.is_past_bedtime_warning === 1) === dose.isPastBedtimeWarning
      ) {
        continue; // No material change — leave the row (and its updated_at) alone.
      }
      db.prepare(
        `UPDATE daily_schedules
            SET scheduled_for = ?, deferred_reason = ?, is_past_bedtime_warning = ?, updated_at = ?
          WHERE id = ? AND profile_id = ?`,
      ).run(
        dose.newScheduledFor,
        dose.deferredReason,
        dose.isPastBedtimeWarning ? 1 : 0,
        transitionAt,
        dose.id,
        profileId,
      );
      updated += 1;
    }
    for (const id of removedIds) {
      db.prepare('DELETE FROM daily_schedules WHERE id = ? AND profile_id = ?').run(id, profileId);
    }
  });
  apply();

  return {
    created,
    removed: removedIds.length,
    updated,
    doses: listScheduleDoses(db, profileId),
  };
}

export interface ShiftSummary {
  wakeDeltaMinutes: number;
  hasBedtimeWarnings: boolean;
  doses: ScheduleDoseRecord[];
}

/**
 * "Woke up late" (PRD §4): shift every unresolved dose by the clamped wake
 * delta, re-enforce buffers forward-only around frozen doses, persist, and
 * store the new wake anchor so the next shift is relative to it.
 */
export function applyShift(
  db: SqliteDb,
  profileId: string,
  newWakeTime: string,
  now: Date,
): ShiftSummary {
  if (!isHhMmClock(newWakeTime)) {
    throw new RangeError(`newWakeTime must be HH:MM, got "${newWakeTime}"`);
  }
  const settings = getScheduleSettings(db, profileId);
  const medications = listMedications(db, profileId);
  const rows = loadScheduleRows(db, profileId);
  const dayIso = dayIsoOf(now);

  const result = recalculateDynamicSchedule({
    doses: rows.map(rowEvent),
    oldWakeTime: clockInstant(dayIso, settings.wakeTime),
    newWakeTime: clockInstant(dayIso, newWakeTime),
    bedtime: clockInstant(dayIso, settings.bedtime),
    bufferRequirements: buildBufferRequirements(medications),
  });

  const transitionAt = now.toISOString();
  const apply = db.transaction(() => {
    for (const dose of result.doses) {
      if (dose.frozen) continue; // CONFIRMED/SKIPPED rows are never rewritten.
      const before = rows.find((row) => row.id === dose.id);
      if (
        before &&
        before.scheduled_for === dose.newScheduledFor &&
        before.deferred_reason === dose.deferredReason &&
        (before.is_past_bedtime_warning === 1) === dose.isPastBedtimeWarning
      ) {
        continue;
      }
      db.prepare(
        `UPDATE daily_schedules
            SET scheduled_for = ?, deferred_reason = ?, is_past_bedtime_warning = ?, updated_at = ?
          WHERE id = ? AND profile_id = ?`,
      ).run(
        dose.newScheduledFor,
        dose.deferredReason,
        dose.isPastBedtimeWarning ? 1 : 0,
        transitionAt,
        dose.id,
        profileId,
      );
    }
  });
  apply();

  updateScheduleSettings(db, profileId, { wakeTime: newWakeTime, bedtime: settings.bedtime });

  return {
    wakeDeltaMinutes: result.wakeDeltaMinutes,
    hasBedtimeWarnings: result.hasBedtimeWarnings,
    doses: listScheduleDoses(db, profileId),
  };
}

export type DoseTransition = 'confirm' | 'skip';

export type TransitionOutcome =
  | { kind: 'resolved'; dose: ScheduleDoseRecord }
  | { kind: 'not_found' }
  | { kind: 'not_transitionable'; current: AdherenceStatus };

/**
 * UI dose transition (same lifecycle as the SMS loop: PENDING/ESCALATED →
 * CONFIRMED/SKIPPED via the shared engine). A resolved dose's pending
 * escalation job is cancelled so the caregiver never hears about a handled
 * dose — the same rule the SMS path applies.
 */
export function transitionDose(
  db: SqliteDb,
  profileId: string,
  scheduleId: string,
  action: DoseTransition,
  now: Date,
): TransitionOutcome {
  const row = db
    .prepare('SELECT * FROM daily_schedules WHERE id = ? AND profile_id = ?')
    .get(scheduleId, profileId) as ScheduleRow | undefined;
  if (!row) return { kind: 'not_found' };

  const current = row.adherence_status as AdherenceStatus;
  const next = nextDoseStatus(current, action);
  if (next === null) return { kind: 'not_transitionable', current };

  const transitionAt = now.toISOString();
  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE daily_schedules
          SET adherence_status = ?, confirmed_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ?`,
    ).run(next, action === 'confirm' ? transitionAt : null, transitionAt, scheduleId, profileId);

    db.prepare(
      `UPDATE escalation_jobs SET status = 'cancelled'
        WHERE daily_schedule_id = ? AND status = 'pending'`,
    ).run(scheduleId);
  });
  apply();

  const dose = getScheduleDose(db, profileId, scheduleId);
  if (!dose) {
    // The row existed at read time; a vanished row is an integrity failure.
    throw new Error(`Dose ${scheduleId} disappeared during transition`);
  }
  return { kind: 'resolved', dose };
}
