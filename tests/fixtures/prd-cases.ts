/**
 * Canonical PRD fixtures (PRD §§3–5) encoded as data.
 *
 * These are the cases the spec's verification table names: the worked
 * levothyroxine/calcium shift case, the confidence-gate thresholds on both
 * sides of 0.70, the SMS protocol phrases, and the escalation timing example.
 * Engines and integration tests both import from here so the contract has one
 * source of truth.
 */

import type { MedicationBufferRequirement, MedicationRiskProfile, ScheduleShiftInput } from '@/lib/engines/types';

/**
 * Fixture medication: engine risk profile plus the DB-shaped columns the
 * integration layer will carry. Engines only read the risk-profile subset.
 */
export interface FixtureMedication extends MedicationRiskProfile {
  profileId: string;
  brandName: string;
  genericName: string;
  dosage: string;
  instructionsRaw: string;
  rxcui: string;
}

/** PRD §4 worked case bedtime anchor: 22:00 on the fixture day. */
export const BEDTIME = '2026-09-17T22:00:00.000Z';

/** The demo profile's fixed UUID (PRD §2: single seeded user, no auth yet). */
export const DEMO_PROFILE_ID = 'a0000000-0000-4000-8000-000000000001';

/** Levothyroxine (Synthroid) — RxNorm 11289. */
export const LEVOTHYROXINE: FixtureMedication = {
  id: 'med-levothyroxine',
  profileId: DEMO_PROFILE_ID,
  brandName: 'Synthroid',
  genericName: 'levothyroxine',
  dosage: '50 mcg',
  instructionsRaw: 'Take on an empty stomach 30–60 minutes before breakfast.',
  rxcui: '11289',
  highRiskSideEffects: [],
};

/** Calcium carbonate (Tums) — RxNorm 21925. */
export const CALCIUM_CARBONATE: FixtureMedication = {
  id: 'med-calcium-carbonate',
  profileId: DEMO_PROFILE_ID,
  brandName: 'Tums',
  genericName: 'calcium carbonate',
  dosage: '500 mg',
  instructionsRaw: 'Take with food.',
  rxcui: '21925',
  highRiskSideEffects: [],
};

/** Lisinopril — dizziness is the monitored risk (PRD §5 protocol example). */
export const LISINOPRIL: FixtureMedication = {
  id: 'med-lisinopril',
  profileId: DEMO_PROFILE_ID,
  brandName: 'Zestril',
  genericName: 'lisinopril',
  dosage: '10 mg',
  instructionsRaw: 'Take once daily.',
  rxcui: '82116',
  highRiskSideEffects: ['dizziness'],
};

/** PRD §4: levothyroxine must be separated 2 hours from calcium carbonate. */
export const LEVO_CALCIUM_BUFFER: MedicationBufferRequirement[] = [
  {
    medicationId: LEVOTHYROXINE.id,
    pairedWithMedicationId: CALCIUM_CARBONATE.id,
    minBufferMinutes: 120,
    bufferType: 'absorption',
  },
];

/** PRD §4 worked case: wake 07:00 → 09:30, levothyroxine held 2 h from calcium. */
export const WORKED_CASE: ScheduleShiftInput = {
  oldWakeTime: '2026-09-17T07:00:00.000Z',
  newWakeTime: '2026-09-17T09:30:00.000Z',
  bedtime: BEDTIME,
  bufferRequirements: LEVO_CALCIUM_BUFFER,
  doses: [
    { id: 'dose-levo', medicationId: LEVOTHYROXINE.id, scheduledFor: '2026-09-17T07:00:00.000Z', adherenceStatus: 'PENDING' },
    { id: 'dose-calcium', medicationId: CALCIUM_CARBONATE.id, scheduledFor: '2026-09-17T08:30:00.000Z', adherenceStatus: 'PENDING' },
  ],
};

/** PRD §3 fixture scores straddling the 0.70 gate. */
export const CONFIDENCE_FIXTURES = {
  below: 0.69,
  atThreshold: 0.7,
  above: 0.71,
} as const;

/** PRD §5 inbound confirmation keyword fixtures. */
export const CONFIRMATION_KEYWORDS = ['1', 'YES', 'CONFIRMED'] as const;

/** PRD §5 two-way symptom protocol fixtures. */
export const SYMPTOM_PROTOCOL = {
  flagKeyword: 'DIZZY',
  canonicalSymptom: 'dizziness',
  affirm: 'DIZZY YES',
  deny: 'DIZZY NO',
} as const;

/** PRD §5 escalation example: a dose missed at 3 PM escalates at 3:45 PM. */
export const ESCALATION_EXAMPLE = {
  scheduledFor: '2026-09-17T15:00:00.000Z',
  escalatesAt: '2026-09-17T15:45:00.000Z',
} as const;
