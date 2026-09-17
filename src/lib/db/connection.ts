import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate';

export type SqliteDb = Database.Database;

export function defaultDbPath(): string {
  return process.env.SICKBAY_DB_PATH ?? './data/sickbay.db';
}

export function openDatabase(dbPath: string): SqliteDb {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

let cached: SqliteDb | null = null;

/** Production entry point: opens the configured database and migrates it. */
export function getDb(): SqliteDb {
  if (!cached) {
    cached = runMigrations(openDatabase(defaultDbPath()));
  }
  return cached;
}
