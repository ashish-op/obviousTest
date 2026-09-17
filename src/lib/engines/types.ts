/**
 * Shared domain types for the pure engines under src/lib/engines/.
 *
 * These mirror the PRD §2 DDL enums exactly (see src/lib/db/migrations/0001_init.sql)
 * so engine output maps 1:1 onto persistence rows.
 *
 * Engines are I/O-free: they never import adapters or the database. Every
 * wall-clock dependency is injected as an explicit `Date` parameter.
 */

/** PRD §2 enum `adherence_status`. */
export type AdherenceStatus = 'PENDING' | 'CONFIRMED' | 'ESCALATED' | 'SKIPPED';

/** PRD §2 enum `deferred_reason` — why a schedule row's time was displaced. */
export type DeferredReason = 'buffer_push' | 'wake_shift';

/** PRD §2 enum `buffer_type`. */
export type BufferType = 'absorption' | 'interaction';

/** Escalation job lifecycle (PRD §2 `escalation_jobs.status`). */
export type EscalationJobStatus = 'pending' | 'dispatched' | 'cancelled';

/**
 * A dose row as the engines see it. All timestamps are absolute ISO-8601
 * instants (the SQLite storage format, e.g. `2026-09-17T07:00:00.000Z`).
 */
export interface DoseEvent {
  id: string;
  medicationId: string;
  /** Absolute ISO-8601 instant — the dose's scheduled anchor time. */
  scheduledFor: string;
  adherenceStatus: AdherenceStatus;
  /** Current past-bedtime flag; preserved for frozen doses, recomputed for moved ones. */
  isPastBedtimeWarning?: boolean;
  /**
   * Why the dose sits where it does ('wake_shift' | 'buffer_push'), carried in
   * from persisted state. A solve that makes no new displacement preserves it
   * — a deferred marker is a durable fact, not a per-solve artifact.
   */
  deferredReason?: DeferredReason | null;
}

/**
 * An undirected timing constraint between two medications: a dose of
 * `medicationId` and a dose of `pairedWithMedicationId` must be separated by
 * at least `minBufferMinutes`, whichever comes second. The solver symmetrizes
 * and applies it directionally at scheduling time (PRD §4 `bufferRequirements`).
 */
export interface MedicationBufferRequirement {
  medicationId: string;
  pairedWithMedicationId: string;
  minBufferMinutes: number;
  bufferType: BufferType;
}

/** Input to `recalculateDynamicSchedule` (PRD §4 `ScheduleShiftInput`). */
export interface ScheduleShiftInput {
  /** The full day's doses across all medications, in any input order. */
  doses: DoseEvent[];
  /** Baseline wake anchor (the wake time the schedule was built from). */
  oldWakeTime: string;
  /** New wake anchor ("Woke up late" tap). */
  newWakeTime: string;
  /** Bedtime anchor for the gold past-bedtime warning (PRD §4 `isPastBedtimeWarning`). */
  bedtime: string;
  /** Undirected per-med buffer requirements (PRD §4 `bufferRequirements`). */
  bufferRequirements: MedicationBufferRequirement[];
}

/** One dose after recalculation (PRD §4 result rows). */
export interface ShiftedDose {
  id: string;
  medicationId: string;
  originalScheduledFor: string;
  newScheduledFor: string;
  adherenceStatus: AdherenceStatus;
  /** True when the final time differs from the original scheduled time. */
  wasShifted: boolean;
  /**
   * `wake_shift` — moved by the wake delta only; `buffer_push` — displaced by
   * a buffer rule (final cause, even when the delta moved it first); null — untouched.
   */
  deferredReason: DeferredReason | null;
  isPastBedtimeWarning: boolean;
  /** True for CONFIRMED/SKIPPED doses, which are never rewritten (PRD §4). */
  frozen: boolean;
}

/** Output of `recalculateDynamicSchedule` (PRD §4). */
export interface ScheduleShiftResult {
  /** Sorted by new scheduled time ascending (ties broken by id) — render order. */
  doses: ShiftedDose[];
  /** Applied wake delta in minutes (never negative — see the solver's clamp). */
  wakeDeltaMinutes: number;
  /** True when any dose carries the gold past-bedtime warning. */
  hasBedtimeWarnings: boolean;
}

/** The slice of an escalation job row the sweep decisions need. */
export interface EscalationJobView {
  id: string;
  /** Absolute ISO-8601 instant the caregiver message should go out. */
  deliverAt: string;
  status: EscalationJobStatus;
}

/** The slice of a medication row the risk-matrix decisions need. */
export interface MedicationRiskProfile {
  id: string;
  /** Canonical symptom names, e.g. `["dizziness"]` (PRD §2 `high_risk_side_effects`). */
  highRiskSideEffects: string[];
}
