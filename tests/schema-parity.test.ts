import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from './helpers';

/**
 * Pins the PRD §2 DDL contract (as rendered in docs/prd-ddl.sql) against the
 * live introspected SQLite schema — column names, order, types, nullability,
 * defaults, enum CHECK constraints, foreign keys, and indexes — so neither the
 * migration nor the documented contract can drift silently.
 */

const PRD_TABLES = [
  'profiles',
  'medications',
  'daily_schedules',
  'side_effect_logs',
  'audit_logs',
  'sms_outbox',
  'escalation_jobs',
] as const;

/** [name, type, notnull, default — null means "no DEFAULT clause"] */
type ColumnSpec = [name: string, type: string, notnull: 0 | 1, dflt: string | null];

const COLUMNS: Record<string, ColumnSpec[]> = {
  profiles: [
    ['id', 'TEXT', 1, null],
    ['full_name', 'TEXT', 1, null],
    ['phone_encrypted', 'TEXT', 1, null],
    ['caregiver_name', 'TEXT', 0, null],
    ['caregiver_phone_encrypted', 'TEXT', 0, null],
    ['created_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
    ['updated_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ],
  medications: [
    ['id', 'TEXT', 1, null],
    ['profile_id', 'TEXT', 1, null],
    ['brand_name', 'TEXT', 0, null],
    ['generic_name', 'TEXT', 1, null],
    ['dosage', 'TEXT', 1, null],
    ['instructions_raw', 'TEXT', 1, null],
    ['rxcui', 'TEXT', 0, null],
    ['buffer_type', 'TEXT', 0, null],
    ['min_buffer_minutes', 'INTEGER', 0, null],
    ['high_risk_side_effects', 'TEXT', 1, "'[]'"],
    ['source', 'TEXT', 1, "'manual'"],
    ['extraction_confidence', 'REAL', 0, null],
    ['created_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
    ['updated_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ],
  daily_schedules: [
    ['id', 'TEXT', 1, null],
    ['profile_id', 'TEXT', 1, null],
    ['medication_id', 'TEXT', 1, null],
    ['scheduled_for', 'TEXT', 1, null],
    ['adherence_status', 'TEXT', 1, "'PENDING'"],
    ['confirmed_at', 'TEXT', 0, null],
    ['escalated_at', 'TEXT', 0, null],
    ['deferred_reason', 'TEXT', 0, null],
    ['is_past_bedtime_warning', 'INTEGER', 1, '0'],
    ['created_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
    ['updated_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ],
  side_effect_logs: [
    ['id', 'TEXT', 1, null],
    ['profile_id', 'TEXT', 1, null],
    ['medication_id', 'TEXT', 1, null],
    ['daily_schedule_id', 'TEXT', 0, null],
    ['symptom', 'TEXT', 1, null],
    ['severity', 'INTEGER', 1, null],
    ['reported_via', 'TEXT', 1, "'sms'"],
    ['reported_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
    ['created_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ],
  audit_logs: [
    ['id', 'TEXT', 1, null],
    ['user_id', 'TEXT', 0, null],
    ['action', 'TEXT', 1, null],
    ['user_agent', 'TEXT', 0, null],
    ['hashed_ip', 'TEXT', 0, null],
    ['details', 'TEXT', 0, null],
    ['created_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ],
  sms_outbox: [
    ['id', 'TEXT', 1, null],
    ['profile_id', 'TEXT', 0, null],
    ['direction', 'TEXT', 1, null],
    ['recipient_encrypted', 'TEXT', 0, null],
    ['sender', 'TEXT', 0, null],
    ['body', 'TEXT', 1, null],
    ['media_url', 'TEXT', 0, null],
    ['provider_message_id', 'TEXT', 0, null],
    ['delivery_mode', 'TEXT', 1, "'fixture'"],
    ['related_daily_schedule_id', 'TEXT', 0, null],
    ['created_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ],
  escalation_jobs: [
    ['id', 'TEXT', 1, null],
    ['daily_schedule_id', 'TEXT', 1, null],
    ['profile_id', 'TEXT', 1, null],
    ['deliver_at', 'TEXT', 1, null],
    ['status', 'TEXT', 1, "'pending'"],
    ['attempts', 'INTEGER', 1, '0'],
    ['dispatched_at', 'TEXT', 0, null],
    ['created_at', 'TEXT', 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"],
  ],
};

/** Every enum rendered as a CHECK constraint, with its exact value set. */
const ENUM_CHECKS: [table: string, column: string, values: string[]][] = [
  ['medications', 'buffer_type', ['absorption', 'interaction']],
  ['medications', 'source', ['ocr', 'manual']],
  ['daily_schedules', 'adherence_status', ['PENDING', 'CONFIRMED', 'ESCALATED', 'SKIPPED']],
  ['daily_schedules', 'deferred_reason', ['buffer_push', 'wake_shift']],
  ['side_effect_logs', 'reported_via', ['sms', 'app']],
  ['sms_outbox', 'direction', ['outbound', 'inbound']],
  ['sms_outbox', 'delivery_mode', ['real', 'fixture']],
  ['escalation_jobs', 'status', ['pending', 'dispatched', 'cancelled']],
];

const FK_EXPECTATIONS: [table: string, references: string[]][] = [
  ['medications', ['profiles']],
  ['daily_schedules', ['profiles', 'medications']],
  ['side_effect_logs', ['profiles', 'medications', 'daily_schedules']],
  ['sms_outbox', ['profiles', 'daily_schedules']],
  ['escalation_jobs', ['daily_schedules', 'profiles']],
];

const INDEXES: [name: string, table: string][] = [
  ['idx_medications_profile', 'medications'],
  ['idx_daily_schedules_profile_status', 'daily_schedules'],
  ['idx_daily_schedules_scheduled', 'daily_schedules'],
  ['idx_side_effect_logs_profile', 'side_effect_logs'],
  ['idx_audit_logs_created', 'audit_logs'],
  ['idx_sms_outbox_created', 'sms_outbox'],
  ['idx_escalation_jobs_sweep', 'escalation_jobs'],
];

function tableSql(db: Database.Database, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`table ${table} not found`);
  return row.sql.replace(/\s+/g, ' ');
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Strip comments and collapse whitespace so comment-only drift doesn't matter. */
function normalizeDdl(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('schema parity — PRD §2 DDL contract', () => {
  const { db } = createTestDb();

  it('creates exactly the seven contract tables (plus _migrations)', () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables.sort()).toEqual([...PRD_TABLES, '_migrations'].sort());
  });

  for (const table of PRD_TABLES) {
    it(`${table}: columns match the contract exactly (name, order, type, nullability, default)`, () => {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];

      const expected = COLUMNS[table];
      expect(
        info.map((c) => [c.name, c.type, c.notnull, c.dflt_value]),
        `${table} columns`,
      ).toEqual(expected.map(([name, type, notnull, dflt]) => [name, type, notnull, dflt]));

      // PK handling: exactly one PK per table, on `id`.
      const pks = info.filter((c) => c.pk === 1);
      expect(pks.map((c) => c.name), `${table} primary key`).toEqual(['id']);
    });
  }

  it('id primary keys reject NULL (SQLite does not imply NOT NULL for non-INTEGER PKs)', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO profiles (id, full_name, phone_encrypted) VALUES (NULL, 'x', 'v1:a:b:c')",
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });

  it('every enum renders as a CHECK constraint with the contract value set', () => {
    for (const [table, column, values] of ENUM_CHECKS) {
      const sql = tableSql(db, table);
      // And the CHECK clause for that column must admit exactly the contract values.
      const checkMatch = sql.match(new RegExp(`${column} IN \\(([^)]*)\\)`));
      expect(checkMatch, `${table}.${column} CHECK clause`).not.toBeNull();
      const allowed = checkMatch![1].split(',').map((v) => v.trim().replace(/'/g, ''));
      expect(allowed.sort(), `${table}.${column} allowed values`).toEqual([...values].sort());
    }
  });

  it('severity is constrained to 1–5', () => {
    const sql = tableSql(db, 'side_effect_logs');
    expect(sql).toContain('severity BETWEEN 1 AND 5');
  });

  it('buffer minutes, attempts, and extraction confidence carry their domain checks', () => {
    expect(tableSql(db, 'medications')).toContain('min_buffer_minutes >= 0');
    expect(tableSql(db, 'medications')).toContain(
      'extraction_confidence >= 0 AND extraction_confidence <= 1',
    );
    expect(tableSql(db, 'escalation_jobs')).toContain('attempts >= 0');
  });

  it('foreign keys wire children to their parents with the expected targets', () => {
    for (const [table, references] of FK_EXPECTATIONS) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
        table: string;
        to: string | null;
      }[];
      expect(fks.map((f) => f.table).sort(), `${table} FK targets`).toEqual([...references].sort());
      expect(fks.every((f) => f.to === 'id' || f.to === null), `${table} FK columns`).toBe(true);
    }
  });

  it('enforces foreign keys at write time (foreign_keys pragma ON)', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO daily_schedules (id, profile_id, medication_id, scheduled_for) VALUES ('s1', 'nope', 'nope2', '2026-09-17T08:00:00Z')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects adherence statuses outside the enum and severities outside 1–5', () => {
    // Seed a valid profile + medication to attach rows to.
    db.prepare(
      "INSERT INTO profiles (id, full_name, phone_encrypted) VALUES ('p1', 'Test Patient', 'v1:a:b:c')",
    ).run();
    db.prepare(
      "INSERT INTO medications (id, profile_id, generic_name, dosage, instructions_raw) VALUES ('m1', 'p1', 'Levothyroxine', '75 mcg', 'daily, empty stomach')",
    ).run();

    expect(() =>
      db
        .prepare(
          "INSERT INTO daily_schedules (id, profile_id, medication_id, scheduled_for, adherence_status) VALUES ('s2', 'p1', 'm1', '2026-09-17T08:00:00Z', 'TAKEN')",
        )
        .run(),
    ).toThrow(/CHECK/);

    expect(() =>
      db
        .prepare(
          "INSERT INTO side_effect_logs (id, profile_id, medication_id, symptom, severity) VALUES ('se1', 'p1', 'm1', 'dizziness', 6)",
        )
        .run(),
    ).toThrow(/CHECK/);

    // Boundary values are accepted.
    db.prepare(
      "INSERT INTO side_effect_logs (id, profile_id, medication_id, symptom, severity) VALUES ('se2', 'p1', 'm1', 'dizziness', 5)",
    ).run();
    db.prepare(
      "INSERT INTO side_effect_logs (id, profile_id, medication_id, symptom, severity) VALUES ('se3', 'p1', 'm1', 'nausea', 1)",
    ).run();
  });

  it('has the contract indexes on their tables', () => {
    for (const [name, table] of INDEXES) {
      const row = db
        .prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(name) as { tbl_name: string } | undefined;
      expect(row, `index ${name}`).toBeDefined();
      expect(row!.tbl_name, `index ${name} on ${table}`).toBe(table);
    }
  });

  it('migration file and docs/prd-ddl.sql are statement-identical (drift guard)', () => {
    const migrationsDir = path.join(repoRoot(), 'src', 'lib', 'db', 'migrations');
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(migrationFiles).toEqual(['0001_init.sql']);

    const migrationSql = migrationFiles
      .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
      .join('\n');
    const canonicalSql = fs.readFileSync(path.join(repoRoot(), 'docs', 'prd-ddl.sql'), 'utf8');

    expect(normalizeDdl(migrationSql)).toBe(normalizeDdl(canonicalSql));
  });
});
