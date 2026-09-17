import { describe, expect, it } from 'vitest';
import type { Adapters, LabelExtractionResult, VisionOcrAdapter } from '@/lib/adapters/types';
import { LabelExtractionError } from '@/lib/adapters/concentrateai';
import { createFixtureVisionAdapter } from '@/lib/adapters/fixture';
import { extractFromPhotos } from '@/lib/ingestion/extract';
import { mergeSideEffects } from '@/lib/ingestion/side-effects';
import { ApiValidationError } from '@/lib/api/errors';
import { normalizeMedicationName } from '@/lib/engines/rxnorm';
import { adaptersFor, createTestDb } from './helpers';

/** Adapter stub returning one fixed extraction — exact scores for the gate. */
function fixedAdapter(result: LabelExtractionResult | Error): VisionOcrAdapter {
  return {
    extractLabel: () =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  };
}

function extractionWith(confidence: number, genericName = 'levothyroxine'): LabelExtractionResult {
  return {
    brandName: 'Synthroid',
    genericName,
    dosage: '50 mcg',
    instructionsRaw: 'Take once daily in the morning on an empty stomach.',
    confidence,
    highRiskSideEffects: [],
    rxcui: null,
  };
}

describe('extraction handler — confidence gate routing (PRD §3)', () => {
  it('routes 0.69 to the low-confidence modal branch', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(fixedAdapter(extractionWith(0.69))) },
      ['/api/ingest/files/a.png'],
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'succeeded', gate: 'low_confidence_review' });
  });

  it('routes 0.70 (exactly the threshold) to auto-populate', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(fixedAdapter(extractionWith(0.7))) },
      ['/api/ingest/files/a.png'],
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'succeeded', gate: 'auto_populate' });
  });

  it('routes 0.71 to auto-populate', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(fixedAdapter(extractionWith(0.71))) },
      ['/api/ingest/files/a.png'],
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'succeeded', gate: 'auto_populate' });
  });

  it('branches per image across a batch (fixture rotation straddles the gate)', async () => {
    const db = createTestDb();
    // Fixture rotation from index 1: 0.71 (auto), 0.69 (review), 0.42 (review).
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(createFixtureVisionAdapter({ startIndex: 1 })) },
      ['/api/ingest/files/1.png', '/api/ingest/files/2.png', '/api/ingest/files/3.png'],
    );
    expect(
      result.outcomes.map((outcome) => (outcome.status === 'succeeded' ? outcome.gate : outcome.status)),
    ).toEqual(['auto_populate', 'low_confidence_review', 'low_confidence_review']);
  });

  it('normalizes a known generic name to its seeded RxNorm entry', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(fixedAdapter(extractionWith(0.94))) },
      ['/api/ingest/files/a.png'],
    );
    const first = result.outcomes[0];
    expect(first.status).toBe('succeeded');
    if (first.status === 'succeeded') {
      expect(first.rxnorm).toEqual({
        rxcui: '11289',
        genericName: 'levothyroxine',
        highRiskSideEffects: [],
      });
    }
  });

  it('flags an unknown generic name for manual RXCUI entry (rxnorm: null, never a guess)', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(fixedAdapter(extractionWith(0.9, 'unobtanium forte'))) },
      ['/api/ingest/files/a.png'],
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'succeeded', rxnorm: null });
  });

  it('merges RxNorm seed effects with label warnings, case-insensitively deduped', () => {
    const match = normalizeMedicationName('lisinopril');
    expect(mergeSideEffects(['dizziness', 'Orthostasis'], match)).toEqual([
      'dizziness',
      'Orthostasis',
    ]);
    expect(mergeSideEffects(['nausea'], normalizeMedicationName('metformin'))).toEqual(['nausea']);
    expect(mergeSideEffects(['DIZZINESS'], null)).toEqual(['DIZZINESS']);
    expect(mergeSideEffects([], null)).toEqual([]);
  });

  it('surfaces an adapter failure as a failed outcome, never a silent skip', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(fixedAdapter(new LabelExtractionError('upstream 502', 502))) },
      ['/api/ingest/files/a.png'],
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'failed', reason: 'upstream 502' });
  });

  it('surfaces a malformed confidence as a failed outcome, not a silent branch', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(fixedAdapter(extractionWith(1.5))) },
      ['/api/ingest/files/a.png'],
    );
    expect(result.outcomes[0].status).toBe('failed');
  });

  it('rejects empty and oversized batches before calling the adapter', async () => {
    const db = createTestDb();
    const adapters = adaptersFor(fixedAdapter(extractionWith(0.9)));
    await expect(extractFromPhotos({ db: db.db, adapters }, [])).rejects.toThrow(
      'No image URLs provided',
    );
    const urls = Array.from({ length: 11 }, (_, i) => `/api/ingest/files/${i}.png`);
    await expect(extractFromPhotos({ db: db.db, adapters }, urls)).rejects.toThrow(
      ApiValidationError,
    );
  });
});
