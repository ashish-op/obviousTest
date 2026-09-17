/**
 * SMS message composition (PRD §5 two-way loop).
 *
 * Pure string builders — no I/O, no clock, no database. Every outbound text
 * carries the "Sickbay:" prefix so the demo console and a real phone render
 * the same sender identity. Nothing here interprets or advises on medication;
 * replies acknowledge state and route to the caregiver (scope invariant).
 */

import { type SideEffectCheckIn } from '@/lib/engines/risk-matrix';
import { toInstant } from '@/lib/engines/time';

/**
 * An affirmed SMS symptom report ("DIZZY YES") carries no graded severity;
 * the protocol's severity bands live in the risk-matrix engine
 * (AFFIRMED_REPORT_SEVERITY / NEGATIVE_CHECK_IN_SEVERITY) alongside every
 * other side-effect decision — messages only compose strings.
 */

/** "2026-09-17T15:00:00.000Z" -> "15:00 UTC" — the demo runs in UTC. */
export function formatTimeLabel(iso: string): string {
  return `${toInstant(iso).toISOString().slice(11, 16)} UTC`;
}

export function confirmationReply(medicationName: string, dosage: string, scheduledFor: string): string {
  return `Sickbay: Confirmed — ${medicationName} ${dosage}, ${formatTimeLabel(scheduledFor)} dose.`;
}

/** Check-in questions appended to a confirmation when the med has high-risk effects. */
export function appendSideEffectCheckIns(reply: string, checkIns: readonly SideEffectCheckIn[]): string {
  if (checkIns.length === 0) return reply;
  const questions = checkIns.map((checkIn) => checkIn.prompt).join(' ');
  return `${reply} ${questions}`;
}

export function skipReply(medicationName: string): string {
  return `Sickbay: Noted — ${medicationName} marked as skipped. This appears in your physician report.`;
}

export function noPendingDoseReply(): string {
  return 'Sickbay: There is no dose waiting for confirmation right now.';
}

export function unknownCommandReply(): string {
  return "Sickbay: We didn't understand that. Reply 1 to confirm your dose, NO to skip it, or DIZZY YES / DIZZY NO to report dizziness.";
}

export function unknownSenderReply(): string {
  return "Sickbay: This number isn't linked to a patient profile. Please contact your care team to register.";
}

export function symptomReportAckReply(canonicalSymptom: string, affirmed: boolean): string {
  if (!affirmed) {
    return `Sickbay: Thank you — we've noted no ${canonicalSymptom}. This check-in is part of your physician report.`;
  }
  return `Sickbay: Thank you — your ${canonicalSymptom} report was recorded and your caregiver has been notified.`;
}

export function unattributableSymptomReply(canonicalSymptom: string): string {
  return `Sickbay: Thank you — your ${canonicalSymptom} report was noted, but we couldn't link it to a confirmed dose. Your caregiver has still been notified.`;
}

/** Caregiver notice for a symptom report (PRD §5: caregiver notice on symptom flag). */
export function caregiverSymptomMessage(input: {
  patientName: string;
  canonicalSymptom: string;
  medicationName: string | null;
  scheduledFor: string | null;
}): string {
  if (input.medicationName && input.scheduledFor) {
    return `Sickbay: ${input.patientName} reported ${input.canonicalSymptom} after their ${formatTimeLabel(input.scheduledFor)} dose of ${input.medicationName}.`;
  }
  return `Sickbay: ${input.patientName} reported ${input.canonicalSymptom} via SMS (not linked to a specific dose).`;
}

/** The 45-minute escalation text the sweep sends the caregiver (PRD §5). */
export function caregiverEscalationMessage(input: {
  patientName: string;
  medicationName: string;
  scheduledFor: string;
}): string {
  return `Sickbay: ${input.patientName}'s ${formatTimeLabel(input.scheduledFor)} dose of ${input.medicationName} hasn't been confirmed after 45 minutes. They may need a reminder.`;
}
