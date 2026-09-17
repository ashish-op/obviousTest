/**
 * Side-effect risk matrix (PRD §5 + §8 advocacy reporting).
 *
 * Pure decisions over a reported symptom: which PRD-specified notifications a
 * report triggers, and which check-in questions a medication owes the patient.
 * The routing policy lives here as named constants so it is testable and
 * tunable; nothing here writes to the database — callers persist the results.
 */

import type { MedicationRiskProfile } from './types';

/**
 * Symptom keyword → canonical symptom. `DIZZY` is the PRD §5 protocol keyword
 * for dizziness; canonical names uppercase to themselves.
 */
const SYMPTOM_ALIASES: Readonly<Record<string, string>> = {
  DIZZY: 'dizziness',
  DIZZINESS: 'dizziness',
};

/**
 * Map an inbound keyword to its canonical symptom name.
 * Case-insensitive; null for unrecognized keywords (never guess a symptom).
 */
export function canonicalizeSymptomKeyword(raw: string): string | null {
  const keyword = raw.trim().toUpperCase();
  return SYMPTOM_ALIASES[keyword] ?? null;
}

/** The SMS keyword for a canonical symptom (e.g. `dizziness` → `DIZZY`). */
export function symptomKeyword(canonicalSymptom: string): string {
  // Prefer the PRD protocol keyword when one exists (dizziness → DIZZY);
  // otherwise the uppercase canonical name is its own keyword.
  const protocolKeyword = Object.entries(SYMPTOM_ALIASES).find(
    ([keyword, canonical]) => canonical === canonicalSymptom && keyword !== canonicalSymptom.trim().toUpperCase(),
  )?.[0];
  return protocolKeyword ?? canonicalSymptom.trim().toUpperCase();
}

/** Severity is an integer 1–5, matching the DDL CHECK constraint. */
export function isValidSeverity(severity: number): boolean {
  return Number.isInteger(severity) && severity >= 1 && severity <= 5;
}

/** Severity ≥ 4 is severe: the caregiver hears about it even off-protocol. */
const SEVERE_SEVERITY = 4;
/** Severity ≥ 3 (moderate and up) is flagged for physician reconciliation. */
const RECONCILIATION_MIN_SEVERITY = 3;

export interface SideEffectReportAssessment {
  /** The canonical symptom name (already canonicalized by the caller). */
  symptom: string;
  severity: number;
  /** The symptom is on this medication's high-risk list. */
  isHighRiskForMedication: boolean;
  /**
   * PRD §5: caregiver notice on symptom flag — true when the symptom matches
   * the medication's high-risk list, or the report is severe (≥ 4).
   */
  requiresCaregiverNotice: boolean;
  /**
   * The report appears in the physician advocacy PDF with a reconciliation
   * prompt: any high-risk match (orthostatic dizziness flags deprescribing
   * opportunities) or moderate-plus severity (≥ 3).
   */
  flagsForReconciliation: boolean;
}

/**
 * Assess one reported side effect. Throws RangeError on out-of-range severity —
 * the DDL CHECK would reject the row anyway, so fail before composing messages.
 */
export function assessSideEffectReport(input: {
  symptom: string;
  severity: number;
  medication: MedicationRiskProfile;
}): SideEffectReportAssessment {
  if (!isValidSeverity(input.severity)) {
    throw new RangeError(`severity must be an integer 1–5, got ${input.severity}`);
  }
  const symptom = input.symptom.trim().toLowerCase();
  const isHighRisk = input.medication.highRiskSideEffects.includes(symptom);
  return {
    symptom,
    severity: input.severity,
    isHighRiskForMedication: isHighRisk,
    requiresCaregiverNotice: isHighRisk || input.severity >= SEVERE_SEVERITY,
    flagsForReconciliation: isHighRisk || input.severity >= RECONCILIATION_MIN_SEVERITY,
  };
}

export interface SideEffectCheckIn {
  /** The SMS keyword the patient replies to, e.g. `DIZZY`. */
  keyword: string;
  canonicalSymptom: string;
  /** Patient-facing check-in question, phrased for the two-way SMS loop. */
  prompt: string;
}

/**
 * The side-effect check-ins a confirmed dose owes the patient (PRD §5: dose
 * confirmation triggers the check-in for meds whose high-risk list is
 * non-empty). One question per high-risk symptom, in list order.
 */
export function buildSideEffectCheckIns(medication: MedicationRiskProfile): SideEffectCheckIn[] {
  return medication.highRiskSideEffects.map((canonicalSymptom) => {
    const keyword = symptomKeyword(canonicalSymptom);
    return {
      keyword,
      canonicalSymptom,
      prompt: `Did you experience ${canonicalSymptom} since taking this dose? Reply ${keyword} YES or ${keyword} NO.`,
    };
  });
}

/**
 * Parse the `high_risk_side_effects` JSON column into engine input.
 * Throws on malformed JSON — corrupted risk data must surface, not silently
 * downgrade a medication's monitoring.
 */
export function parseHighRiskSideEffects(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`high_risk_side_effects must be a JSON array of strings, got: ${raw}`);
  }
  return parsed;
}
