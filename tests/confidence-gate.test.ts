import { describe, expect, it } from 'vitest';
import {
  LOW_CONFIDENCE_ACTIONS,
  OCR_CONFIDENCE_THRESHOLD,
  evaluateExtractionConfidence,
  isLowConfidenceAction,
} from '@/lib/engines/confidence-gate';

describe('OCR confidence gate — PRD §3 threshold at exactly 0.70', () => {
  it('exposes the threshold as the named PRD constant', () => {
    expect(OCR_CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it('routes 0.69 to the low-confidence modal', () => {
    expect(evaluateExtractionConfidence(0.69)).toBe('low_confidence_review');
  });

  it('routes exactly 0.70 to card auto-population (modal is strictly below the threshold)', () => {
    expect(evaluateExtractionConfidence(0.7)).toBe('auto_populate');
  });

  it('routes 0.71 to card auto-population', () => {
    expect(evaluateExtractionConfidence(0.71)).toBe('auto_populate');
  });

  it('routes the extremes correctly', () => {
    expect(evaluateExtractionConfidence(0)).toBe('low_confidence_review');
    expect(evaluateExtractionConfidence(1)).toBe('auto_populate');
  });

  it('throws on out-of-range and malformed scores instead of silently branching', () => {
    expect(() => evaluateExtractionConfidence(-0.01)).toThrow(RangeError);
    expect(() => evaluateExtractionConfidence(1.01)).toThrow(RangeError);
    expect(() => evaluateExtractionConfidence(Number.NaN)).toThrow(RangeError);
  });
});

describe('PRD §3 low-confidence modal actions', () => {
  it('lists the three audited actions', () => {
    expect([...LOW_CONFIDENCE_ACTIONS]).toEqual(['grant_permission_to_call', 'retake_photo', 'manual_override']);
  });

  it('recognizes valid action strings and rejects others', () => {
    expect(isLowConfidenceAction('retake_photo')).toBe(true);
    expect(isLowConfidenceAction('grant_permission_to_call')).toBe(true);
    expect(isLowConfidenceAction('manual_override')).toBe(true);
    expect(isLowConfidenceAction('dismiss')).toBe(false);
  });
});
