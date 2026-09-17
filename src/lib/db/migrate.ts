import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/** Applied-migration bookkeeping; not part of the PRD contract. */
const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

/**
 * Applies every not-yet-applied *.sql file in migrationsDir, in lexicographic
 * order, each inside a transaction. Returns the same connection for chaining.
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string = MIGRATIONS_DIR,
): Database.Database {
  db.exec(MIGRATIONS_TABLE_SQL);

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    });
    apply();
  }

  return db;
}
