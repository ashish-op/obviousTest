/**
 * Side-effect monitoring integration tests (task 8 acceptance: "integration
 * tests assert check-in trigger on high-risk confirmation, log persistence,
 * and red-flag surfacing").
 *
 * The full monitoring loop runs through the real webhook route (form-encoded
 * bodies — the exact shape Twilio sends) into side_effect_logs and out
 * through the red-flag timeline loader the monitor and the task-9 PDF both
 * consume. Fixture mode only: CI has no credentials and can never reach a
 * real service.
 */

import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { TEST_KEY_HEX } from './helpers';

// The route resolves its store through getDb() at call time; pin the temp DB
// BEFORE the route module loads so the singleton lands on the test database.
const testDir = mkdtempSync(path.join(tmpdir(), 'sickbay-monitoring-'));
process.env.SICKBAY_DB_PATH = path.join(testDir, 'monitoring.db');
process.env.PHONE_ENCRYPTION_KEY = TEST_KEY_HEX;

const { POST } = await import('@/app/api/telephony/sms-inbound/route');
const { getDb } = await import('@/lib/db/connection');
const { encryptPhoneNumber, decryptPhoneNumber } = await import('@/lib/crypto/phone-crypto');
const { loadSideEffectTimeline } = await import('@/lib/monitoring/side-effect-store');
const {
  AFFIRMED_REPORT_SEVERITY,
  NEGATIVE_CHECK_IN_SEVERITY,
  RECONCILIATION_MIN_SEVERITY,
} = await import('@/lib/engines/risk-matrix');

const KEY = Buffer.from(TEST_KEY_HEX, 'hex');
const WEBHOOK_URL = 'https://sickbay.example/api/telephony/sms-inbound';
const PATIENT_PHONE = '+15550000000';
const CAREGIVER_PHONE = '+15550002222';
const HIGH_RISK_AT = '2026-09-17T08:00:00.000Z';
const PLAIN_AT = '2026-09-17T12:00:00.000Z';

const db = getDb();

interface SeedResult {
  profileId: string;
  highRiskScheduleId: string;
  plainScheduleId: string;
}

/** Patient + caregiver + a high-risk dose (08:00) and a risk-free dose (12:00). */
function seedPatient(): SeedResult {
  const profileId = crypto.randomUUID();
  db.prepare(
    'INSERT INTO profiles (id, full_name, phone_encrypted, caregiver_name, caregiver_phone_encrypted) VALUES (?, ?, ?, ?, ?)',
  ).run(
    profileId,
    'Test Patient',
    encryptPhoneNumber(PATIENT_PHONE, KEY),
    'Care Person',
    encryptPhoneNumber(CAREGIVER_PHONE, KEY),
  );

  const highRiskScheduleId = seedDose(profileId, 'Levothyroxine', HIGH_RISK_AT, '["dizziness"]');
  const plainScheduleId = seedDose(profileId, 'Calcium Carbonate', PLAIN_AT, '[]');
  return { profileId, highRiskScheduleId, plainScheduleId };
}

function seedDose(profileId: string, genericName: string, scheduledFor: string, highRisk: string): string {
  const medicationId = crypto.randomUUID();
  const scheduleId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO medications (id, profile_id, generic_name, dosage, instructions_raw, high_risk_side_effects)
     VALUES (?, ?, ?, '50 mcg', 'Take once daily.', ?)`,
  ).run(medicationId, profileId, genericName, highRisk);
  db.prepare(
    'INSERT INTO daily_schedules (id, profile_id, medication_id, scheduled_for) VALUES (?, ?, ?, ?)',
  ).run(scheduleId, profileId, medicationId, scheduledFor);
  return scheduleId;
}

function scheduleIdByTime(scheduledFor: string): string {
  return (
    db.prepare('SELECT id FROM daily_schedules WHERE scheduled_for = ?').get(scheduledFor) as { id: string }
  ).id;
}

function confirmDose(scheduleId: string, confirmedAt: string): void {
  db.prepare(
    `UPDATE daily_schedules SET adherence_status = 'CONFIRMED', confirmed_at = ? WHERE id = ?`,
  ).run(confirmedAt, scheduleId);
}

function wipeTables(): void {
  for (const table of [
    'sms_outbox',
    'escalation_jobs',
    'side_effect_logs',
    'daily_schedules',
    'medications',
    'profiles',
    'audit_logs',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

function inboundRequest(body: string): NextRequest {
  return new NextRequest(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: PATIENT_PHONE, To: '+15550001111', Body: body }).toString(),
  });
}

/** Outbound rows (recipient decrypted), oldest first — the caregiver/patient audit trail. */
function outboundRows(): { to: string; body: string }[] {
  return (
    db
      .prepare(`SELECT recipient_encrypted, body FROM sms_outbox WHERE direction = 'outbound' ORDER BY rowid`)
      .all() as { recipient_encrypted: string | null; body: string }[]
  ).map((row) => ({
    to: row.recipient_encrypted ? decryptPhoneNumber(row.recipient_encrypted, KEY) : '(none)',
    body: row.body,
  }));
}

function logRows(): { severity: number; daily_schedule_id: string | null; symptom: string }[] {
  return db
    .prepare('SELECT symptom, severity, daily_schedule_id FROM side_effect_logs ORDER BY rowid')
    .all() as { severity: number; daily_schedule_id: string | null; symptom: string }[];
}

afterAll(() => {
  delete process.env.SICKBAY_DB_PATH;
  delete process.env.PHONE_ENCRYPTION_KEY;
});

describe('side-effect monitoring loop', () => {
  beforeEach(wipeTables);

  it('triggers the check-in questions when a high-risk medication dose is confirmed', async () => {
    seedPatient();

    const response = await POST(inboundRequest('1'));
    const payload = (await response.json()) as { outcome: { status: string } };
    expect(payload.outcome.status).toBe('confirmed');

    const [reply] = outboundRows();
    expect(reply.to).toBe(PATIENT_PHONE);
    // PRD §5 protocol — the confirmation carries the owed check-in.
    expect(reply.body).toContain('Did you experience dizziness');
    expect(reply.body).toContain('Reply DIZZY YES or DIZZY NO');
  });

  it('asks no check-in question when the confirmed medication monitors nothing', async () => {
    const { plainScheduleId } = seedPatient();
    // Resolve the 08:00 high-risk dose first so "1" lands on the 12:00 dose.
    confirmDose(scheduleIdByTime(HIGH_RISK_AT), '2026-09-17T08:05:00.000Z');

    const response = await POST(inboundRequest('1'));
    const payload = (await response.json()) as { outcome: { status: string; scheduleId: string } };
    expect(payload.outcome.status).toBe('confirmed');
    expect(payload.outcome.scheduleId).toBe(plainScheduleId);

    const [reply] = outboundRows();
    expect(reply.to).toBe(PATIENT_PHONE);
    expect(reply.body).toContain('Calcium Carbonate');
    expect(reply.body).not.toContain('Reply DIZZY');
  });

  it('persists an affirmed DIZZY YES at the fail-safe severity and surfaces a red flag', async () => {
    const { highRiskScheduleId, profileId } = seedPatient();
    confirmDose(highRiskScheduleId, '2026-09-17T08:05:00.000Z');

    const response = await POST(inboundRequest('DIZZY YES'));
    const payload = (await response.json()) as {
      outcome: { status: string; canonicalSymptom: string; scheduleId: string };
    };
    expect(payload.outcome.status).toBe('symptom_report');
    expect(payload.outcome.canonicalSymptom).toBe('dizziness');
    expect(payload.outcome.scheduleId).toBe(highRiskScheduleId);

    // Log persistence: severity band 4, attributed to the confirmed dose.
    const [log] = logRows();
    expect(log.symptom).toBe('dizziness');
    expect(log.severity).toBe(AFFIRMED_REPORT_SEVERITY);
    expect(log.severity).toBeGreaterThanOrEqual(RECONCILIATION_MIN_SEVERITY);
    expect(log.daily_schedule_id).toBe(highRiskScheduleId);

    // Caregiver notice first, then the patient ack.
    const messages = outboundRows();
    expect(messages).toHaveLength(2);
    expect(messages[0].to).toBe(CAREGIVER_PHONE);
    expect(messages[0].body).toContain('dizziness');

    // Red-flag surfacing through the loader the monitor and PDF consume.
    const timeline = loadSideEffectTimeline(db, profileId);
    expect(timeline.hasRedFlags).toBe(true);
    expect(timeline.redFlagCount).toBe(1);
    const entry = timeline.entries.find((candidate) => candidate.scheduleId === highRiskScheduleId);
    expect(entry?.checkInState).toBe('red_flag');
    expect(entry?.isRedFlag).toBe(true);
    expect(entry?.logs[0].reconciliationPrompt).toContain('reconciliation');
  });

  it('persists a denied DIZZY NO as a clean check-in that flags nothing', async () => {
    const { highRiskScheduleId, profileId } = seedPatient();
    confirmDose(highRiskScheduleId, '2026-09-17T08:05:00.000Z');

    const response = await POST(inboundRequest('DIZZY NO'));
    const payload = (await response.json()) as { outcome: { status: string; affirmed: boolean } };
    expect(payload.outcome.status).toBe('symptom_report');
    expect(payload.outcome.affirmed).toBe(false);

    // The answer is part of the monitoring record — severity band 1 = denied.
    const [log] = logRows();
    expect(log.symptom).toBe('dizziness');
    expect(log.severity).toBe(NEGATIVE_CHECK_IN_SEVERITY);
    expect(log.daily_schedule_id).toBe(highRiskScheduleId);

    const messages = outboundRows();
    expect(messages).toHaveLength(1); // patient ack only — no caregiver page
    expect(messages[0].to).toBe(PATIENT_PHONE);

    const timeline = loadSideEffectTimeline(db, profileId);
    expect(timeline.hasRedFlags).toBe(false);
    const entry = timeline.entries.find((candidate) => candidate.scheduleId === highRiskScheduleId);
    expect(entry?.checkInState).toBe('clean');
    expect(entry?.isRedFlag).toBe(false);
  });

  it('shows an outstanding check-in for a confirmed high-risk dose awaiting a reply', () => {
    const { highRiskScheduleId, profileId } = seedPatient();
    confirmDose(highRiskScheduleId, '2026-09-17T08:05:00.000Z');

    const timeline = loadSideEffectTimeline(db, profileId);
    const entry = timeline.entries.find((candidate) => candidate.scheduleId === highRiskScheduleId);
    expect(entry?.checkInState).toBe('outstanding');
    expect(timeline.hasRedFlags).toBe(false);
  });

  it('keeps the caregiver loop alive for an affirmed report with nothing confirmed to attribute', async () => {
    seedPatient();

    const response = await POST(inboundRequest('DIZZY YES'));
    const payload = (await response.json()) as { outcome: { status: string; scheduleId: string | null } };
    expect(payload.outcome.status).toBe('symptom_report');
    expect(payload.outcome.scheduleId).toBeNull();

    // No confirmed medication to attribute: no log row (medication_id is NOT
    // NULL), but the fail-safe caregiver notice still goes out.
    expect(logRows()).toHaveLength(0);
    const messages = outboundRows();
    expect(messages[0].to).toBe(CAREGIVER_PHONE);
    expect(messages[0].body).toContain('not linked to a specific dose');
  });

  it('attributes a symptom to the confirmed fallback dose when it matches no high-risk list', async () => {
    const { plainScheduleId, profileId } = seedPatient();
    // Only the risk-free 12:00 dose is confirmed: dizziness matches no
    // high-risk list, so the report falls back to the most recent confirmed dose.
    confirmDose(plainScheduleId, '2026-09-17T12:05:00.000Z');

    const response = await POST(inboundRequest('DIZZY YES'));
    const payload = (await response.json()) as { outcome: { scheduleId: string } };
    expect(payload.outcome.scheduleId).toBe(plainScheduleId);

    const [log] = logRows();
    expect(log.severity).toBe(AFFIRMED_REPORT_SEVERITY);
    expect(log.daily_schedule_id).toBe(plainScheduleId);

    // Fail-safe: severe-band reports flag for reconciliation even off-list.
    const timeline = loadSideEffectTimeline(db, profileId);
    expect(timeline.redFlagCount).toBe(1);
    const entry = timeline.entries.find((candidate) => candidate.scheduleId === plainScheduleId);
    expect(entry?.isRedFlag).toBe(true);
  });
});
