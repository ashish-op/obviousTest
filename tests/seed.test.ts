import { describe, expect, it } from 'vitest';
import { openDatabase } from '@/lib/db/connection';
import {
  DEMO_PROFILE_ID,
  demoProfileValues,
  seedDemoProfile,
} from '@/lib/db/seed';
import { decryptPhoneNumber } from '@/lib/crypto/phone-crypto';
import { createTestDb, TEST_KEY_HEX } from './helpers';

const KEY = Buffer.from(TEST_KEY_HEX, 'hex');

const TEST_ENV = {
  PHONE_ENCRYPTION_KEY: TEST_KEY_HEX,
  DEMO_PROFILE_FULL_NAME: 'Ada Lovelace',
  DEMO_PROFILE_PHONE: '+15559990001',
  DEMO_CAREGIVER_NAME: 'Grace Hopper',
  DEMO_CAREGIVER_PHONE: '+15559990002',
};

function createSeededDb() {
  const { db, dbPath } = createTestDb();
  seedDemoProfile(db, TEST_ENV);
  return { db, dbPath };
}

function seededRow(db: ReturnType<typeof createTestDb>['db']): Record<string, string> {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(DEMO_PROFILE_ID) as Record<
    string,
    string
  >;
}

describe('seed — demo profile (build spec: single seeded demo user)', () => {
  it('seeds the demo profile at the fixed UUID', () => {
    const { db } = createSeededDb();
    expect(seededRow(db).full_name).toBe('Ada Lovelace');
  });

  it('is idempotent — a second seed is a no-op, not a duplicate', () => {
    const { db } = createSeededDb();
    const second = seedDemoProfile(db, TEST_ENV);
    expect(second.created).toBe(false);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('stores phone numbers only as AES-256-GCM envelopes that decrypt back', () => {
    const { db } = createSeededDb();
    const row = seededRow(db);

    expect(row.phone_encrypted).toMatch(/^v1:/);
    expect(row.phone_encrypted).not.toContain('+15559990001');
    expect(decryptPhoneNumber(row.phone_encrypted, KEY)).toBe('+15559990001');

    expect(row.caregiver_phone_encrypted).toMatch(/^v1:/);
    expect(decryptPhoneNumber(row.caregiver_phone_encrypted, KEY)).toBe('+15559990002');
  });

  it('persists to disk — a fresh connection sees the seeded profile', () => {
    const { db, dbPath } = createSeededDb();
    db.close();

    const reopened = openDatabase(dbPath);
    const row = reopened
      .prepare('SELECT id, full_name FROM profiles WHERE id = ?')
      .get(DEMO_PROFILE_ID) as { id: string; full_name: string };
    expect(row.id).toBe(DEMO_PROFILE_ID);
    expect(row.full_name).toBe('Ada Lovelace');
    reopened.close();
  });

  it('refuses to seed without a usable PHONE_ENCRYPTION_KEY', () => {
    const { db } = createTestDb();
    expect(() => seedDemoProfile(db, { DEMO_PROFILE_PHONE: '+15551112222' })).toThrow(
      /PHONE_ENCRYPTION_KEY is required/,
    );
  });

  it('falls back to documented defaults when env is unset', () => {
    const values = demoProfileValues({ PHONE_ENCRYPTION_KEY: TEST_KEY_HEX });
    expect(values.fullName).toBe('Robert Sharma');
    expect(values.phone).toBe('+15550100001');
    expect(values.caregiverName).toBe('Ashish Patel');
  });
});
