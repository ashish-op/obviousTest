/**
 * OCR confidence gate (PRD §3).
 *
 * Extraction results with confidence ≥ 0.70 auto-populate an editable
 * medication card; anything below opens the low-confidence modal with the
 * three PRD actions. The threshold is a PRD constant, not a clinically
 * validated value — it ships as a named constant so it can be tuned later.
 */

/**
 * PRD §3: the extraction-confidence branch point. Scores at or above this
 * value auto-populate the medication card; scores below open the fallback modal.
 */
export const OCR_CONFIDENCE_THRESHOLD = 0.7;

/** The branch the gate sends a result down. */
export type ConfidenceGate = 'auto_populate' | 'low_confidence_review';

/**
 * Branch on extraction confidence. Exactly `OCR_CONFIDENCE_THRESHOLD` counts
 * as high-confidence (the modal is strictly `<` the threshold), pinned by the
 * 0.69 / 0.70 / 0.71 tests.
 *
 * Throws RangeError on scores outside [0, 1] — a malformed score must surface,
 * never silently branch.
 */
export function evaluateExtractionConfidence(confidence: number): ConfidenceGate {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(`extraction confidence must be within [0, 1], got ${confidence}`);
  }
  return confidence >= OCR_CONFIDENCE_THRESHOLD ? 'auto_populate' : 'low_confidence_review';
}

/**
 * The PRD §3 low-confidence modal actions, as `audit_logs.action` values.
 * Each modal action writes an audit row (the route layer persists it); these
 * constants are the shared contract so the strings live in exactly one place.
 */
export const LOW_CONFIDENCE_ACTIONS = ['grant_permission_to_call', 'retake_photo', 'manual_override'] as const;

export type LowConfidenceAction = (typeof LOW_CONFIDENCE_ACTIONS)[number];

export function isLowConfidenceAction(value: string): value is LowConfidenceAction {
  return (LOW_CONFIDENCE_ACTIONS as readonly string[]).includes(value);
}
