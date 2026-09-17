import { describe, expect, it } from 'vitest';
import { DISCLAIMER_ACK_ACTION, hashIp, recordAuditEvent } from '@/lib/audit';
import { createTestDb } from './helpers';

describe('audit — PRD §8 audit trail', () => {
  it('hashes IPs deterministically with SHA-256', () => {
    expect(hashIp('203.0.113.7')).toBe(hashIp('203.0.113.7'));
    expect(hashIp('203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp('203.0.113.8')).not.toBe(hashIp('203.0.113.7'));
  });

  it('writes one audit_logs row with hashed IP and default timestamp', () => {
    const { db } = createTestDb();
    const record = recordAuditEvent(db, {
      action: DISCLAIMER_ACK_ACTION,
      userId: '00000000-0000-4000-8000-000000000001',
      userAgent: 'vitest',
      ip: '203.0.113.7',
    });
    const row = db
      .prepare('SELECT * FROM audit_logs WHERE id = ?')
      .get(record.id) as Record<string, string>;
    expect(row.action).toBe('disclaimer_acknowledged');
    expect(row.user_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(row.user_agent).toBe('vitest');
    expect(row.hashed_ip).toBe(hashIp('203.0.113.7'));
    expect(row.created_at).toBeTruthy();
  });

  it('stores no raw IP anywhere in the row', () => {
    const { db } = createTestDb();
    recordAuditEvent(db, { action: 'probe', ip: '203.0.113.7' });
    const rows = db
      .prepare('SELECT * FROM audit_logs')
      .all() as Array<Record<string, unknown>>;
    expect(JSON.stringify(rows)).not.toContain('203.0.113.7');
  });

  it('accepts missing user, agent, and IP fields as nulls', () => {
    const { db } = createTestDb();
    const record = recordAuditEvent(db, { action: 'probe' });
    const row = db
      .prepare(
        'SELECT user_id, user_agent, hashed_ip, details FROM audit_logs WHERE id = ?',
      )
      .get(record.id) as Record<string, unknown>;
    expect(row.user_id).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.hashed_ip).toBeNull();
    expect(row.details).toBeNull();
  });

  it('gives every event a distinct id', () => {
    const { db } = createTestDb();
    const first = recordAuditEvent(db, { action: 'probe' });
    const second = recordAuditEvent(db, { action: 'probe' });
    expect(first.id).not.toBe(second.id);
  });
});
