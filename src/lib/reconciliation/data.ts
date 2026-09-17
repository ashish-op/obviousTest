/**
 * View-model assembly for the physician advocacy PDF (PRD §7).
 *
 * Pure: takes loaded rows, returns the exact structure the PDF document
 * renders — dose timeline (the red-flag engine's view model), detected
 * chemical/absorption conflicts with buffer minutes, and patient/report
 * metadata. No I/O, no clock: `generatedAt` is injected by the caller.
 */

import type { SideEffectTimeline } from '@/lib/engines/red-flag-timeline';
import { buildBufferRequirements } from '@/lib/engines/rxnorm';

/** The slice of a medications row the PDF needs. */
export interface MedicationRowView {
  id: string;
  genericName: string;
  dosage: string;
  instructionsRaw: string;
  rxcui: string | null;
}

/** One detected chemical/absorption conflict, in physician-facing names. */
export interface TimingConflictView {
  medicationA: string;
  medicationB: string;
  minBufferMinutes: number;
  bufferType: 'absorption' | 'interaction';
}
export interface ReconciliationPdfData {
  patientName: string;
  /** Injected generation instant (ISO-8601) — printed in the report header. */
  generatedAt: string;
  /** The full current medication list — the PDF prints each dose's dosage. */
  medications: MedicationRowView[];
  timeline: SideEffectTimeline;
  conflicts: TimingConflictView[];
}

/**
 * Derive the timing-conflict section from today's medication list: every
 * seeded interaction pair whose two medications are both present
 * (`buildBufferRequirements`), mapped back to generic names for display.
 * Unknown RXCUIs produce no conflict row — the solver never guesses, and
 * neither does the report.
 */
export function deriveTimingConflicts(medications: readonly MedicationRowView[]): TimingConflictView[] {
  const nameById = new Map(medications.map((med) => [med.id, med.genericName]));
  return buildBufferRequirements(medications).flatMap((requirement) => {
    const nameA = nameById.get(requirement.medicationId);
    const nameB = nameById.get(requirement.pairedWithMedicationId);
    if (!nameA || !nameB) return [];
    return [
      {
        medicationA: nameA,
        medicationB: nameB,
        minBufferMinutes: requirement.minBufferMinutes,
        bufferType: requirement.bufferType,
      },
    ];
  });
}

/** PRD §2 adherence enum → physician-facing label. */
export function adherenceStatusLabel(status: 'PENDING' | 'CONFIRMED' | 'ESCALATED' | 'SKIPPED'): string {
  switch (status) {
    case 'PENDING':
      return 'Pending';
    case 'CONFIRMED':
      return 'Confirmed';
    case 'ESCALATED':
      return 'Escalated';
    case 'SKIPPED':
      return 'Skipped';
  }
}

/** PRD §2 buffer_type enum → physician-facing label. */
export function bufferTypeLabel(type: 'absorption' | 'interaction'): string {
  return type === 'absorption' ? 'absorption' : 'chemical interaction';
}

/**
 * HH:mm slice of an ISO-8601 instant, UTC. The storage format is fixed
 * (strftime('%Y-%m-%dT%H:%M:%fZ')) and the PDF is a deterministic document,
 * so the label is cut from the string instead of locale-formatted.
 */
export function formatTimeLabel(iso: string): string {
  return iso.slice(11, 16);
}

/** YYYY-MM-DD slice of an ISO-8601 instant. */
export function formatDateLabel(iso: string): string {
  return iso.slice(0, 10);
}

/** Assemble the report view model from loaded rows. */
export function buildReconciliationPdfData(input: {
  patientName: string;
  generatedAt: string;
  medications: readonly MedicationRowView[];
  timeline: SideEffectTimeline;
}): ReconciliationPdfData {
  return {
    patientName: input.patientName,
    generatedAt: input.generatedAt,
    medications: [...input.medications],
    timeline: input.timeline,
    conflicts: deriveTimingConflicts(input.medications),
  };
}
