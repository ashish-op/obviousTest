-- =====================================================================
-- Sickbay Polypharmacy Engine — canonical DDL (pinned contract)
-- =====================================================================
-- Source: build spec art_GJnhfsve, "Data layer" — the PRD §2 DDL rendered
-- for local SQLite: enums become CHECK constraints, the auth.users
-- dependency is dropped (demo profile is a seeded row with a fixed UUID;
-- RLS is deferred with auth per the spec's locked decisions), so a real
-- Supabase migration is a lift, not a rewrite.
--
-- This file is the parity contract enforced by tests/schema-parity.test.ts.
-- The executable migration src/lib/db/migrations/0001_init.sql must stay
-- statement-identical to this file (normalized comparison in the test).
--
-- Scope invariant: administrative tracking/advocacy only — this schema
-- never recommends, alters, or validates a prescription.

-- ---------------------------------------------------------------------
-- PRD §2 tables
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT NOT NULL PRIMARY KEY,                 -- UUID; demo seed is fixed
  full_name TEXT NOT NULL,
  phone_encrypted TEXT NOT NULL,                -- AES-256-GCM envelope (PRD §8)
  caregiver_name TEXT,
  caregiver_phone_encrypted TEXT,               -- AES-256-GCM envelope
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS medications (
  id TEXT NOT NULL PRIMARY KEY,                 -- UUID
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  brand_name TEXT,
  generic_name TEXT NOT NULL,
  dosage TEXT NOT NULL,
  instructions_raw TEXT NOT NULL,               -- verbatim label text from OCR/manual entry
  rxcui TEXT,                                   -- NULL until normalized; unknown names flag for manual entry
  buffer_type TEXT CHECK (buffer_type IS NULL OR buffer_type IN ('absorption', 'interaction')),
  min_buffer_minutes INTEGER CHECK (min_buffer_minutes IS NULL OR min_buffer_minutes >= 0),
  high_risk_side_effects TEXT NOT NULL DEFAULT '[]',  -- JSON array, e.g. ["dizziness","orthostasis"]
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('ocr', 'manual')),
  extraction_confidence REAL CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS daily_schedules (
  id TEXT NOT NULL PRIMARY KEY,                 -- UUID
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,                  -- ISO-8601 timing anchor for the dose
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
  id TEXT NOT NULL PRIMARY KEY,                 -- UUID
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  daily_schedule_id TEXT REFERENCES daily_schedules(id) ON DELETE SET NULL,
  symptom TEXT NOT NULL,                        -- e.g. 'dizziness', 'orthostasis'
  severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  reported_via TEXT NOT NULL DEFAULT 'sms' CHECK (reported_via IN ('sms', 'app')),
  reported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------
-- Spec-added operational tables (build spec, "Data layer")
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT NOT NULL PRIMARY KEY,                 -- UUID
  user_id TEXT,                                 -- demo profile id locally; auth user id later
  action TEXT NOT NULL,                         -- e.g. 'disclaimer_acknowledged', 'low_confidence_grant'
  user_agent TEXT,
  hashed_ip TEXT,                               -- SHA-256 of client IP, never raw
  details TEXT,                                 -- JSON payload
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sms_outbox (
  id TEXT NOT NULL PRIMARY KEY,                 -- UUID
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  recipient_encrypted TEXT,                     -- outbound: AES-256-GCM envelope of E.164
  sender TEXT,                                  -- inbound: raw sender from webhook, masked in UI
  body TEXT NOT NULL,
  media_url TEXT,
  provider_message_id TEXT,                     -- Twilio SID in real mode; fixture id otherwise
  delivery_mode TEXT NOT NULL DEFAULT 'fixture' CHECK (delivery_mode IN ('real', 'fixture')),
  related_daily_schedule_id TEXT REFERENCES daily_schedules(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS escalation_jobs (
  id TEXT NOT NULL PRIMARY KEY,                 -- UUID
  daily_schedule_id TEXT NOT NULL REFERENCES daily_schedules(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  deliver_at TEXT NOT NULL,                     -- dose time + 45 min; swept by the in-process dispatcher
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dispatched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_medications_profile ON medications(profile_id);
CREATE INDEX IF NOT EXISTS idx_daily_schedules_profile_status ON daily_schedules(profile_id, adherence_status);
CREATE INDEX IF NOT EXISTS idx_daily_schedules_scheduled ON daily_schedules(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_side_effect_logs_profile ON side_effect_logs(profile_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_created ON sms_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_escalation_jobs_sweep ON escalation_jobs(status, deliver_at);
