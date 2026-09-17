/**
 * Dynamic buffer solver (PRD §4) — the correctness core.
 *
 * One tap ("Woke up late") recalculates the remaining doses of the day:
 *
 * 1. Every unresolved dose's anchor shifts by the wake delta (new − old wake).
 *    Resolved doses — CONFIRMED and SKIPPED — are frozen and never rewritten.
 * 2. Walking the doses in schedule order, each dose enforces its buffer
 *    requirements: a gap shorter than `minBufferMinutes` to a placed partner
 *    dose pushes it FORWARD only, never earlier than its shifted anchor —
 *    `newTime = max(shiftedAnchor, partnerTime + buffer)`.
 * 3. Any dose whose final time lands past bedtime carries
 *    `isPastBedtimeWarning` — rendered as the gold warning (PRD §4/§6).
 *
 * Pure and I/O-free: no clock, no database, no adapters.
 */

import type {
  AdherenceStatus,
  DeferredReason,
  DoseEvent,
  MedicationBufferRequirement,
  ScheduleShiftInput,
  ScheduleShiftResult,
  ShiftedDose,
} from './types';
import { toInstant, toIso } from './time';

/** Statuses that are resolved for the day — the solver may not touch these. */
const FROZEN_STATUSES: ReadonlySet<AdherenceStatus> = new Set(['CONFIRMED', 'SKIPPED']);

/**
 * Applied wake delta, clamped at zero. "Woke up late" never rewrites any dose
 * earlier in the day (PRD §4), so an earlier-than-baseline wake input yields a
 * no-op shift rather than moving doses backward.
 */
export function computeWakeDeltaMinutes(oldWakeTime: string, newWakeTime: string): number {
  const delta = (toInstant(newWakeTime).getTime() - toInstant(oldWakeTime).getTime()) / 60_000;
  return Math.max(0, delta);
}

/**
 * Recalculate the day's schedule after a wake-time shift (PRD §4).
 *
 * Semantics chosen where the PRD is silent (documented for reviewers):
 * - ESCALATED doses are still unresolved, so they shift like PENDING ones.
 * - Buffer requirements are undirected; whichever dose of a pair is placed
 *   second in schedule order is the one pushed, so a single pass suffices.
 *   Concurrent doses resolve deterministically by id order.
 * - A partner with several doses today anchors on its latest placed dose.
 * - A frozen partner time is a fact: the solver pushes the shiftable dose
 *   past it; it never moves the frozen row.
 */
export function recalculateDynamicSchedule(input: ScheduleShiftInput): ScheduleShiftResult {
  const deltaMinutes = computeWakeDeltaMinutes(input.oldWakeTime, input.newWakeTime);
  const bedtime = toInstant(input.bedtime);
  const requirementIndex = buildRequirementIndex(input.bufferRequirements);

  const working = input.doses.map((dose) => ({ dose, original: toInstant(dose.scheduledFor) }));
  // Schedule order: original time, then id for a deterministic tie-break.
  working.sort((a, b) => a.original.getTime() - b.original.getTime() || a.dose.id.localeCompare(b.dose.id));

  // Final placement time per medication id — later doses check buffers against
  // these. Frozen times are pre-seeded so every shiftable dose sees them
  // regardless of walk order; moved doses append as they are placed.
  const placedTimesByMedication = new Map<string, Date[]>();
  const results: ShiftedDose[] = [];

  for (const { dose, original } of working) {
    const frozen = FROZEN_STATUSES.has(dose.adherenceStatus);
    if (frozen) pushPlacedTime(placedTimesByMedication, dose.medicationId, original);
  }

  for (const { dose, original } of working) {
    const frozen = FROZEN_STATUSES.has(dose.adherenceStatus);

    if (frozen) {
      results.push({
        id: dose.id,
        medicationId: dose.medicationId,
        originalScheduledFor: dose.scheduledFor,
        newScheduledFor: dose.scheduledFor,
        adherenceStatus: dose.adherenceStatus,
        wasShifted: false,
        deferredReason: null,
        isPastBedtimeWarning: dose.isPastBedtimeWarning ?? false,
        frozen: true,
      });
      continue;
    }

    // 1. Wake-delta shift — the anchor never moves earlier than it was.
    let final = new Date(original.getTime() + deltaMinutes * 60_000);
    let deferredReason: DeferredReason | null =
      deltaMinutes > 0 ? 'wake_shift' : (dose.deferredReason ?? null);

    // 2. Buffer enforcement: push forward only, never earlier than the anchor.
    for (const constraint of requirementIndex.get(dose.medicationId) ?? []) {
      const partnerTime = latestPlacedTime(placedTimesByMedication, constraint.partnerMedicationId);
      if (partnerTime === null) continue; // Partner not placed yet — it enforces the pair from its side.
      const earliestAllowed = new Date(partnerTime.getTime() + constraint.minBufferMinutes * 60_000);
      if (final.getTime() < earliestAllowed.getTime()) {
        final = earliestAllowed;
        deferredReason = 'buffer_push';
      }
    }

    pushPlacedTime(placedTimesByMedication, dose.medicationId, final);

    // 3. Gold past-bedtime warning on the final placement.
    const isPastBedtimeWarning = final.getTime() > bedtime.getTime();

    results.push({
      id: dose.id,
      medicationId: dose.medicationId,
      originalScheduledFor: dose.scheduledFor,
      newScheduledFor: toIso(final),
      adherenceStatus: dose.adherenceStatus,
      wasShifted: final.getTime() !== original.getTime(),
      deferredReason,
      isPastBedtimeWarning,
      frozen: false,
    });
  }

  // Render order: new scheduled time ascending, id tie-break.
  results.sort(
    (a, b) =>
      toInstant(a.newScheduledFor).getTime() - toInstant(b.newScheduledFor).getTime() ||
      a.id.localeCompare(b.id),
  );

  return {
    doses: results,
    wakeDeltaMinutes: deltaMinutes,
    hasBedtimeWarnings: results.some((dose) => dose.isPastBedtimeWarning),
  };
}

/** Undirected pair → both directions of per-medication constraint lookup. */
function buildRequirementIndex(
  requirements: MedicationBufferRequirement[],
): Map<string, Array<{ partnerMedicationId: string; minBufferMinutes: number }>> {
  const index = new Map<string, Array<{ partnerMedicationId: string; minBufferMinutes: number }>>();
  for (const requirement of requirements) {
    if (requirement.medicationId === requirement.pairedWithMedicationId) continue; // Degenerate self-pair.
    if (!Number.isFinite(requirement.minBufferMinutes) || requirement.minBufferMinutes < 0) {
      throw new RangeError(
        `minBufferMinutes must be a non-negative number, got ${requirement.minBufferMinutes}`,
      );
    }
    addDirection(requirement.medicationId, requirement.pairedWithMedicationId, requirement.minBufferMinutes);
    addDirection(requirement.pairedWithMedicationId, requirement.medicationId, requirement.minBufferMinutes);
  }
  return index;

  function addDirection(medicationId: string, partnerId: string, minBufferMinutes: number): void {
    const constraints = index.get(medicationId) ?? [];
    constraints.push({ partnerMedicationId: partnerId, minBufferMinutes });
    index.set(medicationId, constraints);
  }
}

function latestPlacedTime(map: Map<string, Date[]>, medicationId: string): Date | null {
  const times = map.get(medicationId);
  if (!times || times.length === 0) return null;
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

function pushPlacedTime(map: Map<string, Date[]>, medicationId: string, time: Date): void {
  const times = map.get(medicationId);
  if (times) {
    times.push(time);
  } else {
    map.set(medicationId, [time]);
  }
}
