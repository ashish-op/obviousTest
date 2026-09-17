/**
 * Public surface of the domain engines. Pure functions only — no I/O, no
 * adapter imports, no ambient clock (every "now" is an injected parameter).
 */

export * from './types';
export * from './time';
export { recalculateDynamicSchedule, computeWakeDeltaMinutes } from './schedule-solver';
export { resolveEarliestPendingDose, parseInboundCommand } from './dose-resolution';
export type { InboundCommand } from './dose-resolution';
export {
  ESCALATION_DELAY_MINUTES,
  computeEscalationDeliverAt,
  planEscalation,
  shouldEscalateDose,
  selectDueEscalations,
  nextDoseStatus,
} from './escalation';
export {
  OCR_CONFIDENCE_THRESHOLD,
  evaluateExtractionConfidence,
  LOW_CONFIDENCE_ACTIONS,
  isLowConfidenceAction,
} from './confidence-gate';
export type { ConfidenceGate, LowConfidenceAction } from './confidence-gate';
export {
  canonicalizeSymptomKeyword,
  symptomKeyword,
  isValidSeverity,
  assessSideEffectReport,
  buildSideEffectCheckIns,
  parseHighRiskSideEffects,
} from './risk-matrix';
export type { SideEffectReportAssessment, SideEffectCheckIn } from './risk-matrix';
export {
  RXNORM_SEED,
  INTERACTION_PAIRS,
  normalizeMedicationName,
  buildBufferRequirements,
} from './rxnorm';
export type { RxNormEntry, InteractionPair, RxNormMatch } from './rxnorm';
