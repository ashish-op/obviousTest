import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, type SqliteDb } from '@/lib/db/connection';
import { runMigrations } from '@/lib/db/migrate';

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
