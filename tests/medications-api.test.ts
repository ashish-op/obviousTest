import { describe, expect, it } from 'vitest';
import { createMedication, deleteMedication, getMedication, listMedications, updateMedication } from '@/lib/medications/repository';
import { parseMedicationCoreFields, parseMedicationCreateInput } from '@/lib/medications/validation';
import { ApiValidationError } from '@/lib/api/errors';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { createTestDb } from './helpers';

const OCR_CARD = {
  brandName: 'Synthroid',
  genericName: 'levothyroxine',
  dosage: '50 mcg',
  instructionsRaw: 'Take once daily in the morning on an empty stomach.',
  rxcui: '11289',
  highRiskSideEffects: [],
  source: 'ocr' as const,
  extractionConfidence: 0.94,
};

describe('medication validation — the DDL contract as input rules', () => {
  it('trims and normalizes the editable core fields', () => {
    const core = parseMedicationCoreFields({
      brandName: '  Synthroid ',
      genericName: ' levothyroxine ',
      dosage: '50 mcg',
      instructionsRaw: 'Take once daily.',
      rxcui: '',
    });
    expect(core).toEqual({
      brandName: 'Synthroid',
      genericName: 'levothyroxine',
      dosage: '50 mcg',
      instructionsRaw: 'Take once daily.',
      rxcui: null,
    });
  });

  it('rejects blank required fields', () => {
    expect(() => parseMedicationCoreFields({ ...OCR_CARD, genericName: '   ' })).toThrow(
      ApiValidationError,
    );
    expect(() => parseMedicationCreateInput({ ...OCR_CARD, dosage: null })).toThrow(
      '"dosage" is required',
    );
    expect(() => parseMedicationCreateInput(null)).toThrow('must be a JSON object');
  });

  it('enforces the source CHECK and the confidence range', () => {
    expect(() => parseMedicationCreateInput({ ...OCR_CARD, source: 'wizard' })).toThrow(
      '"source" must be "ocr" or "manual"',
    );
    expect(() => parseMedicationCreateInput({ ...OCR_CARD, extractionConfidence: 1.5 })).toThrow(
      '"extractionConfidence" must be within [0, 1] or null',
    );
    // Boundary values are valid.
    expect(
      parseMedicationCreateInput({ ...OCR_CARD, extractionConfidence: 0 }).extractionConfidence,
    ).toBe(0);
    expect(
      parseMedicationCreateInput({ ...OCR_CARD, extractionConfidence: 1 }).extractionConfidence,
    ).toBe(1);
  });

  it('enforces side-effect list shape and buffer metadata constraints', () => {
    expect(() =>
      parseMedicationCreateInput({ ...OCR_CARD, highRiskSideEffects: ['dizziness', 4] }),
    ).toThrow('"highRiskSideEffects" must be an array of strings');
    expect(() => parseMedicationCreateInput({ ...OCR_CARD, minBufferMinutes: -5 })).toThrow(
      '"minBufferMinutes" must be a non-negative integer or null',
    );
    expect(() => parseMedicationCreateInput({ ...OCR_CARD, bufferType: 'magic' })).toThrow(
      '"bufferType" must be "absorption", "interaction", or null',
    );
  });
});

describe('medication repository — CRUD scoped to a profile', () => {
  it('creates, lists, reads, updates, and deletes an OCR-sourced card', () => {
    const db = createTestDb();
    db.db.prepare(
      'INSERT INTO profiles (id, full_name, phone_encrypted) VALUES (?, ?, ?)',
    ).run(DEMO_PROFILE_ID, 'Robert Sharma', 'enc-not-under-test-here');

    const created = createMedication(db.db, DEMO_PROFILE_ID, {
      ...parseMedicationCreateInput(OCR_CARD),
    });
    expect(created).toMatchObject({
      genericName: 'levothyroxine',
      source: 'ocr',
      extractionConfidence: 0.94,
      profileId: DEMO_PROFILE_ID,
    });
    expect(created.highRiskSideEffects).toEqual([]);

    expect(listMedications(db.db, DEMO_PROFILE_ID)).toHaveLength(1);
    expect(getMedication(db.db, DEMO_PROFILE_ID, created.id)?.genericName).toBe('levothyroxine');

    const updated = updateMedication(db.db, DEMO_PROFILE_ID, created.id, {
      brandName: 'Synthroid (corrected)',
      genericName: 'levothyroxine',
      dosage: '75 mcg',
      instructionsRaw: 'Take once daily on an empty stomach.',
      rxcui: '11289',
    });
    expect(updated?.dosage).toBe('75 mcg');
    expect(updated?.brandName).toBe('Synthroid (corrected)');

    expect(deleteMedication(db.db, DEMO_PROFILE_ID, created.id)).toBe(true);
    expect(getMedication(db.db, DEMO_PROFILE_ID, created.id)).toBeNull();
    expect(deleteMedication(db.db, DEMO_PROFILE_ID, created.id)).toBe(false);
  });

  it('keeps profiles isolated — one profile never reads another’s medications', () => {
    const db = createTestDb();
    db.db.prepare(
      'INSERT INTO profiles (id, full_name, phone_encrypted) VALUES (?, ?, ?)',
    ).run('profile-a', 'A', 'x');
    db.db.prepare(
      'INSERT INTO profiles (id, full_name, phone_encrypted) VALUES (?, ?, ?)',
    ).run('profile-b', 'B', 'y');

    const med = createMedication(db.db, 'profile-a', parseMedicationCreateInput(OCR_CARD));
    expect(getMedication(db.db, 'profile-b', med.id)).toBeNull();
    expect(listMedications(db.db, 'profile-b')).toEqual([]);
    expect(updateMedication(db.db, 'profile-b', med.id, parseMedicationCoreFields(OCR_CARD))).toBeNull();
    expect(deleteMedication(db.db, 'profile-b', med.id)).toBe(false);
  });

  it('round-trips high-risk side effects through their JSON column', () => {
    const db = createTestDb();
    db.db.prepare(
      'INSERT INTO profiles (id, full_name, phone_encrypted) VALUES (?, ?, ?)',
    ).run('profile-c', 'C', 'z');
    const med = createMedication(
      db.db,
      'profile-c',
      parseMedicationCreateInput({
        ...OCR_CARD,
        brandName: 'Zestril',
        genericName: 'lisinopril',
        highRiskSideEffects: ['dizziness', 'orthostasis'],
        source: 'ocr',
        extractionConfidence: 0.88,
      }),
    );
    expect(med.highRiskSideEffects).toEqual(['dizziness', 'orthostasis']);
  });
});
