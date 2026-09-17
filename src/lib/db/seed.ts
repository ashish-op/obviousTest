import type { SqliteDb } from './connection';
import { encryptPhoneNumber, loadEncryptionKey } from '../crypto/phone-crypto';

/** Fixed UUID for the seeded demo profile (build spec: single demo user). */
export const DEMO_PROFILE_ID = '00000000-0000-4000-8000-000000000001';

export interface SeedProfileValues {
  id: string;
  fullName: string;
  phone: string;
  caregiverName: string | null;
  caregiverPhone: string | null;
}

export function demoProfileValues(env: NodeJS.ProcessEnv = process.env): SeedProfileValues {
  return {
    id: DEMO_PROFILE_ID,
    fullName: env.DEMO_PROFILE_FULL_NAME ?? 'Robert Sharma',
    phone: env.DEMO_PROFILE_PHONE ?? '+15550100001',
    caregiverName: env.DEMO_CAREGIVER_NAME ?? 'Ashish Patel',
    caregiverPhone: env.DEMO_CAREGIVER_PHONE ?? '+15550100002',
  };
}

export interface SeedResult {
  id: string;
  created: boolean;
}

/**
 * Idempotently seeds the demo profile. Phone numbers are stored only as
 * AES-256-GCM envelopes — never in plaintext (PRD §8).
 */
export function seedDemoProfile(db: SqliteDb, env: NodeJS.ProcessEnv = process.env): SeedResult {
  const values = demoProfileValues(env);
  const key = loadEncryptionKey(env);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO profiles (id, full_name, phone_encrypted, caregiver_name, caregiver_phone_encrypted)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    values.id,
    values.fullName,
    encryptPhoneNumber(values.phone, key),
    values.caregiverName,
    values.caregiverPhone ? encryptPhoneNumber(values.caregiverPhone, key) : null,
  );

  const row = db
    .prepare('SELECT id FROM profiles WHERE id = ?')
    .get(values.id) as { id: string } | undefined;

  if (!row) {
    throw new Error(`Seeding failed: demo profile ${values.id} not found after insert`);
  }

  return { id: row.id, created: result.changes > 0 };
}
