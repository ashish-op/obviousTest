import { describe, expect, it } from 'vitest';
import { recordLowConfidenceAction } from '@/lib/ingestion/low-confidence';
import { LOW_CONFIDENCE_ACTIONS } from '@/lib/engines/confidence-gate';
import { ApiValidationError } from '@/lib/api/errors';
import { createTestDb } from './helpers';

interface AuditRow {
  id: string;
  user_id: string | null;
  action: string;
  details: string | null;
}

type Db = ReturnType<typeof createTestDb>['db'];

function auditRows(db: Db): AuditRow[] {
  return db
    .prepare('SELECT id, user_id, action, details FROM audit_logs ORDER BY rowid')
    .all() as AuditRow[];
}

describe('low-confidence modal actions — every action writes an audit row (PRD §3)', () => {
  it('records each of the three modal actions with the image context', () => {
    const db = createTestDb();
    const meta = { userId: 'user-1', userAgent: 'vitest', ip: '203.0.113.9' };

    const grant = recordLowConfidenceAction(
      db.db,
      { action: 'grant_permission_to_call', imageUrl: '/api/ingest/files/a.png' },
      meta,
    );
    const retake = recordLowConfidenceAction(
      db.db,
      { action: 'retake_photo', imageUrl: '/api/ingest/files/a.png' },
      meta,
    );
    const manual = recordLowConfidenceAction(
      db.db,
      { action: 'manual_override', imageUrl: null },
      meta,
    );

    const rows = auditRows(db.db);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.action)).toEqual([...LOW_CONFIDENCE_ACTIONS]);
    expect(new Set([grant.auditId, retake.auditId, manual.auditId]).size).toBe(3);
    for (const row of rows) {
      expect(row.user_id).toBe('user-1');
      expect(JSON.parse(row.details ?? '{}')).toHaveProperty('imageUrl');
    }
    expect(JSON.parse(rows[0].details ?? '{}').imageUrl).toBe('/api/ingest/files/a.png');
    expect(JSON.parse(rows[2].details ?? '{}').imageUrl).toBeNull();
  });

  it('rejects unknown actions and non-object bodies without writing rows', () => {
    const db = createTestDb();
    const meta = { userId: 'user-1', userAgent: null, ip: null };

    expect(() =>
      recordLowConfidenceAction(db.db, { action: 'call_pharmacy' }, meta),
    ).toThrow(ApiValidationError);
    expect(() => recordLowConfidenceAction(db.db, 'grant_permission_to_call', meta)).toThrow(
      'must be a JSON object',
    );
    expect(() =>
      recordLowConfidenceAction(db.db, { action: 'grant_permission_to_call', imageUrl: 42 }, meta),
    ).toThrow('imageUrl must be a string or null');

    expect(auditRows(db.db)).toEqual([]);
  });
});
