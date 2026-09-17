/**
 * Day-plan generation (pure) — the bridge from the medication list to the
 * solver's input shape. Slot derivation comes from the instruction parser;
 * buffer requirements come from the RxNorm seed; placement stays the
 * solver's job (`recalculateDynamicSchedule` is the single source of buffer
 * and bedtime semantics — generation runs it with a zero wake delta so the
 * only displacement it applies is forward buffer enforcement).
 */

import { deriveDoseTimes, type DayAnchors } from '@/lib/engines/instructions';
import type { DoseEvent } from '@/lib/engines/types';
import { clockInstant } from './clock';

/** The medication slice slot derivation needs (the repository's records qualify). */
export interface GeneratorMedication {
  id: string;
  instructionsRaw: string;
}

/** One derived but not-yet-persisted dose slot. */
export interface DerivedSlot {
  medicationId: string;
  /** HH:MM wall clock of the slot. */
  clock: string;
}

/**
 * Every dose slot the medication list implies for the day, in deterministic
 * order (medication id, then ascending time).
 */
export function deriveSlots(
  medications: readonly GeneratorMedication[],
  anchors: DayAnchors,
): DerivedSlot[] {
  const slots: DerivedSlot[] = [];
  for (const medication of [...medications].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const clock of deriveDoseTimes(medication.instructionsRaw, anchors)) {
      slots.push({ medicationId: medication.id, clock });
    }
  }
  return slots;
}

/** Shape a derived slot as a solver `DoseEvent` (synthetic id, PENDING). */
export function slotEvent(slot: DerivedSlot, dayIso: string, id: string): DoseEvent {
  return {
    id,
    medicationId: slot.medicationId,
    scheduledFor: clockInstant(dayIso, slot.clock),
    adherenceStatus: 'PENDING',
  };
}
