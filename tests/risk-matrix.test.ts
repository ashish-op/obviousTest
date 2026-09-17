import { describe, expect, it } from 'vitest';
import {
  assessSideEffectReport,
  buildSideEffectCheckIns,
  canonicalizeSymptomKeyword,
  isValidSeverity,
  parseHighRiskSideEffects,
  symptomKeyword,
} from '@/lib/engines/risk-matrix';

const LISINOPRIL = { id: 'med-lisinopril', highRiskSideEffects: ['dizziness'] };
const METFORMIN = { id: 'med-metformin', highRiskSideEffects: ['nausea'] };
const LEVOTHYROXINE = { id: 'med-levothyroxine', highRiskSideEffects: [] };

describe('canonicalizeSymptomKeyword — PRD §5 DIZZY protocol', () => {
  it('maps the PRD DIZZY keyword to dizziness', () => {
    expect(canonicalizeSymptomKeyword('DIZZY')).toBe('dizziness');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(canonicalizeSymptomKeyword(' dizzy ')).toBe('dizziness');
    expect(canonicalizeSymptomKeyword('dizziness')).toBe('dizziness');
  });

  it('returns null for unrecognized keywords — never guesses a symptom', () => {
    expect(canonicalizeSymptomKeyword('RASH')).toBeNull();
    expect(canonicalizeSymptomKeyword('')).toBeNull();
  });

  it('builds the keyword from a canonical symptom name', () => {
    expect(symptomKeyword('dizziness')).toBe('DIZZY');
    expect(symptomKeyword('nausea')).toBe('NAUSEA');
  });
});

describe('isValidSeverity — DDL CHECK parity (integer 1–5)', () => {
  it('accepts integers 1 through 5', () => {
    expect([1, 2, 3, 4, 5].every(isValidSeverity)).toBe(true);
  });

  it('rejects out-of-range, fractional, and malformed values', () => {
    expect(isValidSeverity(0)).toBe(false);
    expect(isValidSeverity(6)).toBe(false);
    expect(isValidSeverity(2.5)).toBe(false);
    expect(isValidSeverity(Number.NaN)).toBe(false);
  });
});

describe('assessSideEffectReport — PRD §5 caregiver notice + §8 reconciliation flags', () => {
  it('flags a high-risk symptom match for caregiver notice even when mild', () => {
    const assessment = assessSideEffectReport({ symptom: 'dizziness', severity: 2, medication: LISINOPRIL });
    expect(assessment.isHighRiskForMedication).toBe(true);
    expect(assessment.requiresCaregiverNotice).toBe(true);
    expect(assessment.flagsForReconciliation).toBe(true); // orthostatic dizziness → deprescribing opportunity
  });

  it('stays quiet for a mild symptom the medication does not risk-flag', () => {
    const assessment = assessSideEffectReport({ symptom: 'nausea', severity: 1, medication: LISINOPRIL });
    expect(assessment.isHighRiskForMedication).toBe(false);
    expect(assessment.requiresCaregiverNotice).toBe(false);
    expect(assessment.flagsForReconciliation).toBe(false);
  });

  it('escalates a severe off-list report to the caregiver', () => {
    const assessment = assessSideEffectReport({ symptom: 'nausea', severity: 5, medication: LEVOTHYROXINE });
    expect(assessment.isHighRiskForMedication).toBe(false);
    expect(assessment.requiresCaregiverNotice).toBe(true);
    expect(assessment.flagsForReconciliation).toBe(true);
  });

  it('routes moderate severity (3) to physician reconciliation without a caregiver notice', () => {
    const assessment = assessSideEffectReport({ symptom: 'headache', severity: 3, medication: LEVOTHYROXINE });
    expect(assessment.requiresCaregiverNotice).toBe(false);
    expect(assessment.flagsForReconciliation).toBe(true);
  });

  it('does not confuse one medication’s risk list with another’s', () => {
    const assessment = assessSideEffectReport({ symptom: 'dizziness', severity: 2, medication: METFORMIN });
    expect(assessment.isHighRiskForMedication).toBe(false); // metformin flags nausea, not dizziness
    expect(assessment.requiresCaregiverNotice).toBe(false);
  });

  it('normalizes symptom casing before matching', () => {
    const assessment = assessSideEffectReport({ symptom: '  Dizziness ', severity: 2, medication: LISINOPRIL });
    expect(assessment.isHighRiskForMedication).toBe(true);
  });

  it('throws on severity outside the DDL CHECK range', () => {
    expect(() => assessSideEffectReport({ symptom: 'dizziness', severity: 0, medication: LISINOPRIL })).toThrow(RangeError);
    expect(() => assessSideEffectReport({ symptom: 'dizziness', severity: 6, medication: LISINOPRIL })).toThrow(RangeError);
  });
});

describe('buildSideEffectCheckIns — PRD §5 post-confirmation check-in', () => {
  it('owes one DIZZY check-in for a dizziness-flagged medication', () => {
    const checkIns = buildSideEffectCheckIns(LISINOPRIL);
    expect(checkIns).toHaveLength(1);
    expect(checkIns[0]).toMatchObject({ keyword: 'DIZZY', canonicalSymptom: 'dizziness' });
    expect(checkIns[0].prompt).toContain('DIZZY YES');
    expect(checkIns[0].prompt).toContain('DIZZY NO');
  });

  it('owes no check-in when the medication has no high-risk side effects', () => {
    expect(buildSideEffectCheckIns(LEVOTHYROXINE)).toEqual([]);
  });

  it('keeps list order when several symptoms are monitored', () => {
    const checkIns = buildSideEffectCheckIns({ id: 'med-x', highRiskSideEffects: ['nausea', 'dizziness'] });
    expect(checkIns.map((checkIn) => checkIn.keyword)).toEqual(['NAUSEA', 'DIZZY']);
  });
});

describe('parseHighRiskSideEffects — high_risk_side_effects JSON column', () => {
  it('parses the stored JSON array', () => {
    expect(parseHighRiskSideEffects('["dizziness","orthostasis"]')).toEqual(['dizziness', 'orthostasis']);
  });

  it('parses the DDL default of an empty array', () => {
    expect(parseHighRiskSideEffects('[]')).toEqual([]);
  });

  it('throws on malformed JSON — corrupted risk data must surface', () => {
    expect(() => parseHighRiskSideEffects('not json')).toThrow();
    expect(() => parseHighRiskSideEffects('{"symptom":"dizziness"}')).toThrow(TypeError);
    expect(() => parseHighRiskSideEffects('[1,2]')).toThrow(TypeError);
  });
});
