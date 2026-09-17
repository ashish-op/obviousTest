-- Migration 0002 — schedule settings.
--
-- Implementation-additive table, same precedent as sms_outbox and
-- escalation_jobs: state the schedule engine needs that the PRD §2 DDL does
-- not model. "Woke up late" shift deltas and past-bedtime warnings are
-- computed against the wake/bedtime anchors the current daily plan was built
-- from, so those anchors must persist across reloads. One row per profile.
--
-- This DDL is appended to docs/prd-ddl.sql (statement-identity contract
-- enforced by tests/schema-parity.test.ts).

CREATE TABLE IF NOT EXISTS schedule_settings (
  id TEXT NOT NULL PRIMARY KEY,
  profile_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  wake_time TEXT NOT NULL DEFAULT '07:00' CHECK (wake_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  bedtime TEXT NOT NULL DEFAULT '22:00' CHECK (bedtime GLOB '[0-2][0-9]:[0-5][0-9]'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
