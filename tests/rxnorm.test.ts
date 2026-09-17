import { describe, expect, it } from 'vitest';
import {
  INTERACTION_PAIRS,
  RXNORM_SEED,
  buildBufferRequirements,
  normalizeMedicationName,
} from '@/lib/engines/rxnorm';

describe('normalizeMedicationName — PRD §4 RxNorm normalization', () => {
  it('normalizes a generic name across casing and punctuation', () => {
    expect(normalizeMedicationName('Levothyroxine')).toMatchObject({ genericName: 'levothyroxine' });
    expect(normalizeMedicationName('LEVOTHYROXINE')).toMatchObject({ genericName: 'levothyroxine' });
    expect(normalizeMedicationName('  levothyroxine ')).toMatchObject({ genericName: 'levothyroxine' });
  });

  it('strips dose-suffixed label text', () => {
    expect(normalizeMedicationName('calcium carbonate 500 mg')).toMatchObject({ genericName: 'calcium carbonate' });
    expect(normalizeMedicationName('Levothyroxine 50 mcg')).toMatchObject({ genericName: 'levothyroxine' });
  });

  it('resolves brand aliases', () => {
    expect(normalizeMedicationName('Synthroid')).toMatchObject({ genericName: 'levothyroxine' });
    expect(normalizeMedicationName('Tums')).toMatchObject({ genericName: 'calcium carbonate' });
    expect(normalizeMedicationName('Glucophage 500 mg')).toMatchObject({ genericName: 'metformin' });
  });

  it('returns a non-null RXCUI for every seed entry', () => {
    for (const entry of RXNORM_SEED) {
      expect(normalizeMedicationName(entry.genericName)).not.toBeNull();
    }
  });

  it('returns null for unknown names — the caller flags for manual RXCUI entry', () => {
    expect(normalizeMedicationName('MegaDrugX')).toBeNull();
    expect(normalizeMedicationName('')).toBeNull();
  });

  it('carries the entry’s high-risk side effects through the match', () => {
    const match = normalizeMedicationName('lisinopril');
    expect(match).toMatchObject({ genericName: 'lisinopril', highRiskSideEffects: ['dizziness'] });
  });
});

describe('INTERACTION_PAIRS — PRD §4 canonical levothyroxine/calcium buffer', () => {
  it('pins the levothyroxine–calcium carbonate 2-hour absorption buffer', () => {
    const levo = RXNORM_SEED.find((entry) => entry.genericName === 'levothyroxine')!;
    const calcium = RXNORM_SEED.find((entry) => entry.genericName === 'calcium carbonate')!;
    const pair = INTERACTION_PAIRS.find(
      (candidate) =>
        (candidate.aRxcui === levo.rxcui && candidate.bRxcui === calcium.rxcui) ||
        (candidate.aRxcui === calcium.rxcui && candidate.bRxcui === levo.rxcui),
    );
    expect(pair).toBeDefined();
    expect(pair!.minBufferMinutes).toBe(120);
    expect(pair!.bufferType).toBe('absorption');
  });
});

describe('buildBufferRequirements — per-med requirements for today’s medications', () => {
  it('emits a requirement for each seeded pair present today', () => {
    const requirements = buildBufferRequirements([
      { id: 'med-levo', rxcui: '11289' },
      { id: 'med-calcium', rxcui: '21925' },
      { id: 'med-metformin', rxcui: '68009' }, // no pair with the others
    ]);

    expect(requirements).toHaveLength(1);
    const requirement = requirements[0];
    expect(new Set([requirement.medicationId, requirement.pairedWithMedicationId])).toEqual(
      new Set(['med-levo', 'med-calcium']),
    );
    expect(requirement.minBufferMinutes).toBe(120);
    expect(requirement.bufferType).toBe('absorption');
  });

  it('emits nothing when no seeded pair is present', () => {
    expect(
      buildBufferRequirements([
        { id: 'med-metformin', rxcui: '68009' },
        { id: 'med-sertraline', rxcui: '82116' },
      ]),
    ).toEqual([]);
  });

  it('skips medications without an RXCUI (awaiting manual entry)', () => {
    expect(
      buildBufferRequirements([
        { id: 'med-levo', rxcui: '11289' },
        { id: 'med-unknown', rxcui: null },
      ]),
    ).toEqual([]);
  });

  it('produces no self-pair when the same medication id covers both RXCUIs', () => {
    expect(
      buildBufferRequirements([
        { id: 'med-both', rxcui: '11289' },
        { id: 'med-both', rxcui: '21925' },
      ]),
    ).toEqual([]);
  });
});
