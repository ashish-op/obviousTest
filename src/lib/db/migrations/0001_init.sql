-- Migration 0001 — initial schema.
-- MUST stay statement-identical to docs/prd-ddl.sql (normalized comparison
-- in tests/schema-parity.test.ts). Edit both together.

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone_encrypted TEXT NOT NULL,
  caregiver_name TEXT,
  caregiver_phone_encrypted TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS medications (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  brand_name TEXT,
  generic_name TEXT NOT NULL,
  dosage TEXT NOT NULL,
  instructions_raw TEXT NOT NULL,
  rxcui TEXT,
  buffer_type TEXT CHECK (buffer_type IS NULL OR buffer_type IN ('absorption', 'interaction')),
  min_buffer_minutes INTEGER CHECK (min_buffer_minutes IS NULL OR min_buffer_minutes >= 0),
  high_risk_side_effects TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('ocr', 'manual')),
  extraction_confidence REAL CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS daily_schedules (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  adherence_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (adherence_status IN ('PENDING', 'CONFIRMED', 'ESCALATED', 'SKIPPED')),
  confirmed_at TEXT,
  escalated_at TEXT,
  deferred_reason TEXT CHECK (deferred_reason IS NULL OR deferred_reason IN ('buffer_push', 'wake_shift')),
  is_past_bedtime_warning INTEGER NOT NULL DEFAULT 0 CHECK (is_past_bedtime_warning IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS side_effect_logs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  daily_schedule_id TEXT REFERENCES daily_schedules(id) ON DELETE SET NULL,
  symptom TEXT NOT NULL,
  severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  reported_via TEXT NOT NULL DEFAULT 'sms' CHECK (reported_via IN ('sms', 'app')),
  reported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  user_agent TEXT,
  hashed_ip TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sms_outbox (
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  recipient_encrypted TEXT,
  sender TEXT,
  body TEXT NOT NULL,
  media_url TEXT,
  provider_message_id TEXT,
  delivery_mode TEXT NOT NULL DEFAULT 'fixture' CHECK (delivery_mode IN ('real', 'fixture')),
  related_daily_schedule_id TEXT REFERENCES daily_schedules(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS escalation_jobs (
  id TEXT PRIMARY KEY,
  daily_schedule_id TEXT NOT NULL REFERENCES daily_schedules(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  deliver_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dispatched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_medications_profile ON medications(profile_id);
CREATE INDEX IF NOT EXISTS idx_daily_schedules_profile_status ON daily_schedules(profile_id, adherence_status);
CREATE INDEX IF NOT EXISTS idx_daily_schedules_scheduled ON daily_schedules(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_side_effect_logs_profile ON side_effect_logs(profile_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_created ON sms_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_escalation_jobs_sweep ON escalation_jobs(status, deliver_at);
