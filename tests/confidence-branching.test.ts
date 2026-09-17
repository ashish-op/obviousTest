import { describe, expect, it } from 'vitest';
import { createFixtureVisionAdapter } from '@/lib/adapters/fixture';
import { extractFromPhotos } from '@/lib/ingestion/extract';
import { recordLowConfidenceAction } from '@/lib/ingestion/low-confidence';
import {
  LOW_CONFIDENCE_ACTIONS,
  evaluateExtractionConfidence,
} from '@/lib/engines/confidence-gate';
import { BLANK_CARD_VALUES, cardValuesFromExtraction } from '@/components/ingestion/MedicationCardForm';
import { ApiValidationError } from '@/lib/api/errors';
import { adaptersFor, createTestDb } from './helpers';

/**
 * Task-5 acceptance: the 0.70 confidence gate branches at exactly 0.70 with
 * fixture scores 0.69 / 0.70 / 0.71 exercising both branches, and every
 * low-confidence modal action writes its audit_logs row. This file is the
 * canonical record for that contract; the route-level tests in
 * ingestion-extract.test.ts cover the same gate through the handler.
 */

interface AuditRow {
  action: string;
  user_id: string | null;
  details: string | null;
}

describe('confidence gate — branch boundary at exactly 0.70 (PRD §3)', () => {
  it('sends 0.69 to the low-confidence modal branch', () => {
    expect(evaluateExtractionConfidence(0.69)).toBe('low_confidence_review');
  });

  it('auto-populates at exactly 0.70 — the boundary belongs to the high branch', () => {
    expect(evaluateExtractionConfidence(0.7)).toBe('auto_populate');
  });

  it('auto-populates above the threshold (0.71)', () => {
    expect(evaluateExtractionConfidence(0.71)).toBe('auto_populate');
  });
});

describe('fixture batch — both branches in one scan', () => {
  it('branches the four-fixture rotation: two auto-populated, two low-confidence', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(createFixtureVisionAdapter()) },
      ['/api/ingest/files/1.png', '/api/ingest/files/2.png', '/api/ingest/files/3.png', '/api/ingest/files/4.png'],
    );
    // Fixture confidences in rotation order: 0.94, 0.71, 0.69, 0.42.
    expect(
      result.outcomes.map((outcome) =>
        outcome.status === 'succeeded' ? outcome.gate : outcome.status,
      ),
    ).toEqual(['auto_populate', 'auto_populate', 'low_confidence_review', 'low_confidence_review']);
    expect(
      result.outcomes.map((outcome) =>
        outcome.status === 'succeeded' ? outcome.extraction.confidence : null,
      ),
    ).toEqual([0.94, 0.71, 0.69, 0.42]);
  });

  it('the 0.71 read carries an RxNorm match; the 0.69 read does not block audit-ready branching', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(createFixtureVisionAdapter({ startIndex: 1 })) },
      ['/api/ingest/files/a.png', '/api/ingest/files/b.png'],
    );
    const [high, low] = result.outcomes;
    expect(high.status === 'succeeded' && high.gate).toBe('auto_populate');
    expect(low.status === 'succeeded' && low.gate).toBe('low_confidence_review');
    expect(high.status === 'succeeded' && high.rxnorm?.rxcui).toBe('21925'); // calcium carbonate (seeded)
    expect(low.status === 'succeeded' && low.extraction.genericName).toBe('metformin');
  });
});

describe('low-confidence branch — every modal action is audited', () => {
  it('records one audit row per modal action for the same weak read', () => {
    const db = createTestDb();
    const imageUrl = '/api/ingest/files/3.png';
    const meta = { userId: 'demo-user', userAgent: 'vitest', ip: '203.0.113.5' };

    const acknowledgments = LOW_CONFIDENCE_ACTIONS.map((action) =>
      recordLowConfidenceAction(db.db, { action, imageUrl }, meta),
    );
    expect(acknowledgments).toHaveLength(3);

    const rows = db.db
      .prepare('SELECT action, user_id, details FROM audit_logs ORDER BY rowid')
      .all() as AuditRow[];
    expect(rows.map((row) => row.action)).toEqual([...LOW_CONFIDENCE_ACTIONS]);
    for (const row of rows) {
      expect(row.user_id).toBe('demo-user');
      const details = JSON.parse(row.details ?? '{}') as { imageUrl?: string };
      expect(details.imageUrl).toBe(imageUrl);
    }
  });

  it('the auto-populate branch writes no audit rows — the modal never opened', async () => {
    const db = createTestDb();
    const result = await extractFromPhotos(
      { db: db.db, adapters: adaptersFor(createFixtureVisionAdapter()) },
      ['/api/ingest/files/1.png'], // 0.94
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'succeeded', gate: 'auto_populate' });
    const rows = db.db.prepare('SELECT action FROM audit_logs').all() as AuditRow[];
    expect(rows).toEqual([]);
  });

  it('an unknown modal action is rejected, never recorded', () => {
    const db = createTestDb();
    expect(() =>
      recordLowConfidenceAction(
        db.db,
        { action: 'grant_permission_to_call', imageUrl: '/api/ingest/files/x.png' },
        { userId: 'demo-user', userAgent: null, ip: null },
      ),
    ).not.toThrow();
    expect(() =>
      recordLowConfidenceAction(
        db.db,
        { action: 'escalate_now' as never, imageUrl: null },
        { userId: 'demo-user', userAgent: null, ip: null },
      ),
    ).toThrow(ApiValidationError);
  });
});

describe('card prefill mapping — what each branch hands the editable card', () => {
  const extraction = {
    brandName: 'Glucophage',
    genericName: 'metformin',
    dosage: '1000 mg',
    instructionsRaw: 'Take one tablet twice daily with meals.',
    confidence: 0.69,
    highRiskSideEffects: ['nausea'],
    rxcui: null,
  };

  it('prefills rxcui from the RxNorm match when the name is known', () => {
    const values = cardValuesFromExtraction(extraction, {
      rxcui: '6809',
      genericName: 'metformin',
      highRiskSideEffects: ['nausea'],
    });
    expect(values).toMatchObject({ brandName: 'Glucophage', rxcui: '6809' });
  });

  it('leaves rxcui blank for an unknown name — manual entry, never a guess', () => {
    const values = cardValuesFromExtraction(extraction, null);
    expect(values.rxcui).toBe('');
    expect(values.genericName).toBe('metformin');
  });

  it('the manual-override card starts blank', () => {
    expect(BLANK_CARD_VALUES).toEqual({
      brandName: '',
      genericName: '',
      dosage: '',
      instructionsRaw: '',
      rxcui: '',
      highRiskSideEffects: [],
    });
  });
});
