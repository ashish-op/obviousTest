import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, type SqliteDb } from '@/lib/db/connection';
import { runMigrations } from '@/lib/db/migrate';
import { encryptPhoneNumber } from '@/lib/crypto/phone-crypto';

export interface TestDb {
  db: SqliteDb;
  dbPath: string;
}

/** Fresh, fully-migrated SQLite database in a per-test temp directory. */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'sickbay-test-'));
  const dbPath = path.join(dir, 'test.db');
  return { db: runMigrations(openDatabase(dbPath)), dbPath };
}

export const TEST_KEY_HEX = 'ab'.repeat(32);

export interface PendingScheduleFixture {
  profileId: string;
  medicationId: string;
  scheduleId: string;
}

/**
 * Minimal valid profile → medication → PENDING daily_schedule chain, for
 * adapters and tests that hit foreign keys (e.g. escalation_jobs).
 */
export function createPendingSchedule(
  db: SqliteDb,
  scheduledFor = '2026-09-17T08:00:00.000Z',
): PendingScheduleFixture {
  const profileId = crypto.randomUUID();
  const medicationId = crypto.randomUUID();
  const scheduleId = crypto.randomUUID();

  db.prepare('INSERT INTO profiles (id, full_name, phone_encrypted) VALUES (?, ?, ?)').run(
    profileId,
    'Adapter Test Patient',
    encryptPhoneNumber('+15550000000', Buffer.from(TEST_KEY_HEX, 'hex')),
  );
  db.prepare(
    `INSERT INTO medications (id, profile_id, generic_name, dosage, instructions_raw)
     VALUES (?, ?, 'test medication', '1 mg', 'Take once daily.')`,
  ).run(medicationId, profileId);
  db.prepare(
    'INSERT INTO daily_schedules (id, profile_id, medication_id, scheduled_for) VALUES (?, ?, ?, ?)',
  ).run(scheduleId, profileId, medicationId, scheduledFor);

  return { profileId, medicationId, scheduleId };
}

export interface RecordedFetchCall {
  input: string;
  init?: RequestInit;
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Fetch stub for recorded-fixture contract tests: records every call and
 * replays one canned Response. No network is possible through it.
 */
export function stubJsonFetch(response: Response): {
  impl: typeof fetch;
  calls: RecordedFetchCall[];
} {
  const calls: RecordedFetchCall[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push({ input: String(input), init });
    return Promise.resolve(response);
  };
  return { impl, calls };
}
