/**
 * Inbound webhook integration tests (PRD §5, build spec verification table:
 * "Inbound SMS protocol routes correctly" and "webhook rejects unsigned
 * requests in real mode").
 *
 * These drive the actual route handler (`POST`) with signed, form-encoded
 * NextRequest bodies — the exact shape Twilio sends. Fixture mode covers the
 * full protocol matrix; real mode covers signature enforcement (403 paths
 * never reach the network; the signed accept path stubs fetch like the
 * adapter contract tests — no live calls anywhere).
 */

import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { TEST_KEY_HEX } from './helpers';

// The route resolves its store through getDb() at call time; pin the temp DB
// BEFORE the route module loads so the singleton lands on the test database.
const testDir = mkdtempSync(path.join(tmpdir(), 'sickbay-inbound-'));
process.env.SICKBAY_DB_PATH = path.join(testDir, 'route.db');
process.env.PHONE_ENCRYPTION_KEY = TEST_KEY_HEX;

const { POST } = await import('@/app/api/telephony/sms-inbound/route');
const { getDb } = await import('@/lib/db/connection');
const { encryptPhoneNumber, decryptPhoneNumber } = await import('@/lib/crypto/phone-crypto');
const { AFFIRMED_REPORT_SEVERITY, NEGATIVE_CHECK_IN_SEVERITY } = await import('@/lib/engines/risk-matrix');

const KEY = Buffer.from(TEST_KEY_HEX, 'hex');
const WEBHOOK_URL = 'https://sickbay.example/api/telephony/sms-inbound';
const PATIENT_PHONE = '+15550000000';
const CAREGIVER_PHONE = '+15550002222';
const STRANGER_PHONE = '+15559999999';
const AUTH_TOKEN = 'inbound-test-token';
const REAL_TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'ACtest00000000000000000000000000',
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_FROM_NUMBER: '+15550001111',
};

/** Independent HMAC construction — explicit canonical string, like the adapter tests. */
function expectedSignature(url: string, fields: Record<string, string>, token = AUTH_TOKEN): string {
  const canonical =
    url +
    Object.keys(fields)
      .sort()
      .map((name) => `${name}${fields[name]}`)
      .join('');
  return crypto.createHmac('sha1', token).update(canonical, 'utf8').digest('base64');
}

function inboundRequest(fields: Record<string, string>, signature?: string): NextRequest {
  return new NextRequest(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(signature === undefined ? {} : { 'X-Twilio-Signature': signature }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const db = getDb();

interface SeedResult {
  profileId: string;
  earlyScheduleId: string;
  lateScheduleId: string;
}

/** Patient + caregiver + two PENDING doses (08:00 levothyroxine, 12:00 calcium). */
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

  const earlyScheduleId = seedDose(profileId, 'Levothyroxine', '2026-09-17T08:00:00.000Z', '["dizziness"]');
  const lateScheduleId = seedDose(profileId, 'Calcium Carbonate', '2026-09-17T12:00:00.000Z', '[]');
  return { profileId, earlyScheduleId, lateScheduleId };
}

function seedDose(
  profileId: string,
  genericName: string,
  scheduledFor: string,
  highRisk: string,
): string {
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

/** Outbound rows (recipient decrypted), oldest first — the caregiver/patient reply audit trail. */
function outboundRows(): { to: string; body: string; deliveryMode: string }[] {
  return (
    db
      .prepare(`SELECT recipient_encrypted, body, delivery_mode FROM sms_outbox WHERE direction = 'outbound' ORDER BY rowid`)
      .all() as { recipient_encrypted: string | null; body: string; delivery_mode: string }[]
  ).map((row) => ({
    to: row.recipient_encrypted ? decryptPhoneNumber(row.recipient_encrypted, KEY) : '(none)',
    body: row.body,
    deliveryMode: row.delivery_mode,
  }));
}

afterAll(() => {
  delete process.env.SICKBAY_DB_PATH;
  delete process.env.PHONE_ENCRYPTION_KEY;
});

describe('POST /api/telephony/sms-inbound — fixture mode protocol matrix', () => {
  beforeEach(wipeTables);

  it('confirms the earliest pending dose on "1" and replies with dose context', async () => {
    const { earlyScheduleId } = seedPatient();

    const response = await POST(
      inboundRequest({ From: PATIENT_PHONE, To: '+15550001111', Body: '1' }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { outcome: { status: string; scheduleId: string } };
    expect(payload.outcome.status).toBe('confirmed');
    expect(payload.outcome.scheduleId).toBe(earlyScheduleId);

    const dose = db
      .prepare('SELECT adherence_status, confirmed_at FROM daily_schedules WHERE id = ?')
      .get(earlyScheduleId) as { adherence_status: string; confirmed_at: string | null };
    expect(dose.adherence_status).toBe('CONFIRMED');
    expect(dose.confirmed_at).not.toBeNull();

    const [reply] = outboundRows();
    expect(reply.to).toBe(PATIENT_PHONE);
    expect(reply.body).toContain('Levothyroxine');
    expect(reply.deliveryMode).toBe('fixture');

    // The inbound message itself is part of the loop the console renders.
    const inbound = db
      .prepare(`SELECT COUNT(*) AS n FROM sms_outbox WHERE direction = 'inbound'`)
      .get() as { n: number };
    expect(inbound.n).toBe(1);
  });

  it('treats "YES" and "CONFIRMED" as confirmations regardless of case', async () => {
    const { earlyScheduleId, lateScheduleId } = seedPatient();

    for (const body of ['yes', 'CONFIRMED']) {
      const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: body }));
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { outcome: { status: string } };
      expect(payload.outcome.status).toBe('confirmed');
    }

    const statuses = db
      .prepare(`SELECT id, adherence_status FROM daily_schedules WHERE id IN (?, ?)`)
      .all(earlyScheduleId, lateScheduleId) as { id: string; adherence_status: string }[];
    expect(statuses.every((row) => row.adherence_status === 'CONFIRMED')).toBe(true);
  });

  it('resolves concurrent pending doses to the earliest-scheduled row', async () => {
    const { earlyScheduleId, lateScheduleId } = seedPatient();

    const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: '1' }));
    const payload = (await response.json()) as { outcome: { scheduleId: string } };

    expect(payload.outcome.scheduleId).toBe(earlyScheduleId);
    const late = db
      .prepare('SELECT adherence_status FROM daily_schedules WHERE id = ?')
      .get(lateScheduleId) as { adherence_status: string };
    expect(late.adherence_status).toBe('PENDING'); // the later dose still awaits
  });

  it('marks the dose SKIPPED on "NO" and cancels its pending escalation job', async () => {
    const { profileId, earlyScheduleId } = seedPatient();
    // A pending job exists because the escalation scheduler ran at dose creation.
    db.prepare(
      `INSERT INTO escalation_jobs (id, daily_schedule_id, profile_id, deliver_at) VALUES (?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), earlyScheduleId, profileId, '2026-09-17T08:45:00.000Z');

    const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: 'NO' }));
    const payload = (await response.json()) as { outcome: { status: string; scheduleId: string } };

    expect(payload.outcome.status).toBe('skipped');
    const dose = db
      .prepare('SELECT adherence_status FROM daily_schedules WHERE id = ?')
      .get(earlyScheduleId) as { adherence_status: string };
    expect(dose.adherence_status).toBe('SKIPPED');
    const job = db
      .prepare('SELECT status FROM escalation_jobs WHERE daily_schedule_id = ?')
      .get(earlyScheduleId) as { status: string };
    expect(job.status).toBe('cancelled');
  });

  it('routes DIZZY YES to a severity-4 side-effect log plus caregiver notice', async () => {
    const { earlyScheduleId } = seedPatient();
    db.prepare(
      `UPDATE daily_schedules SET adherence_status = 'CONFIRMED', confirmed_at = ? WHERE id = ?`,
    ).run('2026-09-17T08:05:00.000Z', earlyScheduleId);

    const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: 'DIZZY YES' }));
    const payload = (await response.json()) as {
      outcome: { status: string; canonicalSymptom: string; scheduleId: string };
    };

    expect(payload.outcome.status).toBe('symptom_report');
    expect(payload.outcome.canonicalSymptom).toBe('dizziness');
    expect(payload.outcome.scheduleId).toBe(earlyScheduleId);

    const log = db
      .prepare('SELECT symptom, severity, daily_schedule_id FROM side_effect_logs')
      .get() as { symptom: string; severity: number; daily_schedule_id: string };
    expect(log.symptom).toBe('dizziness');
    expect(log.severity).toBe(AFFIRMED_REPORT_SEVERITY);
    expect(log.daily_schedule_id).toBe(earlyScheduleId);

    const messages = outboundRows();
    expect(messages).toHaveLength(2);
    expect(messages[0].to).toBe(CAREGIVER_PHONE); // caregiver notified first
    expect(messages[0].body).toContain('dizziness');
    expect(messages[1].to).toBe(PATIENT_PHONE); // then the patient ack
  });

  it('persists DIZZY NO as a clean severity-1 check-in without paging the caregiver', async () => {
    const { earlyScheduleId } = seedPatient();
    db.prepare(
      `UPDATE daily_schedules SET adherence_status = 'CONFIRMED', confirmed_at = ? WHERE id = ?`,
    ).run('2026-09-17T08:05:00.000Z', earlyScheduleId);

    const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: 'DIZZY NO' }));
    const payload = (await response.json()) as { outcome: { status: string; affirmed: boolean } };

    expect(payload.outcome.status).toBe('symptom_report');
    expect(payload.outcome.affirmed).toBe(false);

    // The answer is part of the monitoring record (severity band 1 = denied)
    // — but a denial never flags a symptom or pages the caregiver.
    const log = db
      .prepare('SELECT symptom, severity, daily_schedule_id FROM side_effect_logs')
      .get() as { symptom: string; severity: number; daily_schedule_id: string };
    expect(log.symptom).toBe('dizziness');
    expect(log.severity).toBe(NEGATIVE_CHECK_IN_SEVERITY);
    expect(log.daily_schedule_id).toBe(earlyScheduleId);

    const messages = outboundRows();
    expect(messages).toHaveLength(1); // patient ack only — no caregiver page
    expect(messages[0].to).toBe(PATIENT_PHONE);
    expect(messages[0].body).toContain('no dizziness');
  });

  it('answers an unknown sender politely and audits, changing nothing', async () => {
    seedPatient();

    const response = await POST(inboundRequest({ From: STRANGER_PHONE, Body: '1' }));
    const payload = (await response.json()) as { outcome: { status: string } };

    expect(payload.outcome.status).toBe('unknown_sender');
    const messages = outboundRows();
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe(STRANGER_PHONE);

    // Nothing resolved — the patient's real pending dose is untouched.
    const pending = db
      .prepare(`SELECT COUNT(*) AS n FROM daily_schedules WHERE adherence_status = 'PENDING'`)
      .get() as { n: number };
    expect(pending.n).toBe(2);

    const audit = db
      .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sms_unknown_sender'`)
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it('replies "no pending dose" when nothing is confirmable', async () => {
    const { earlyScheduleId, lateScheduleId } = seedPatient();
    for (const id of [earlyScheduleId, lateScheduleId]) {
      db.prepare(`UPDATE daily_schedules SET adherence_status = 'CONFIRMED' WHERE id = ?`).run(id);
    }

    const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: '1' }));
    const payload = (await response.json()) as { outcome: { status: string } };

    expect(payload.outcome.status).toBe('no_pending_dose');
    const messages = outboundRows();
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe(PATIENT_PHONE);
    expect(messages[0].body.toLowerCase()).toContain('no dose waiting');
  });

  it('treats unrecognized text as an unknown command, never a guess', async () => {
    seedPatient();

    const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: 'hello what is my schedule' }));
    const payload = (await response.json()) as { outcome: { status: string } };

    expect(payload.outcome.status).toBe('unknown_command');
    const pending = db
      .prepare(`SELECT COUNT(*) AS n FROM daily_schedules WHERE adherence_status = 'PENDING'`)
      .get() as { n: number };
    expect(pending.n).toBe(2); // nothing resolved by accident
  });

  it('rejects a malformed (non-form) body with 400', async () => {
    const response = await POST(
      new NextRequest(WEBHOOK_URL, { method: 'POST', body: 'not-a-form', headers: {} }),
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/telephony/sms-inbound — real mode signature enforcement', () => {
  const originalFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};
  const REAL_KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'] as const;

  beforeEach(() => {
    wipeTables();
    for (const key of REAL_KEYS) savedEnv[key] = process.env[key];
  });

  // Restore after EACH test — a leak would silently flip later tests to real mode.
  afterEach(() => {
    for (const key of REAL_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  afterAll(() => {
    for (const key of REAL_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    globalThis.fetch = originalFetch;
  });

  it('rejects an unsigned request with 403 before touching any state', async () => {
    Object.assign(process.env, REAL_TWILIO_ENV);
    seedPatient();

    const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: '1' }));

    expect(response.status).toBe(403);
    const pending = db
      .prepare(`SELECT COUNT(*) AS n FROM daily_schedules WHERE adherence_status = 'PENDING'`)
      .get() as { n: number };
    expect(pending.n).toBe(2); // zero state change
    const outbox = db.prepare('SELECT COUNT(*) AS n FROM sms_outbox').get() as { n: number };
    expect(outbox.n).toBe(0);
  });

  it('rejects a forged signature with 403', async () => {
    Object.assign(process.env, REAL_TWILIO_ENV);
    seedPatient();

    const fields = { From: PATIENT_PHONE, Body: '1' };
    const forged = expectedSignature(WEBHOOK_URL, fields, 'wrong-token');
    const response = await POST(inboundRequest(fields, forged));

    expect(response.status).toBe(403);
  });

  it('accepts a correctly signed form-encoded body end to end (fetch stubbed, no live calls)', async () => {
    Object.assign(process.env, REAL_TWILIO_ENV);
    const { earlyScheduleId } = seedPatient();
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ sid: 'SMinbound-real-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as typeof fetch;

    try {
      const fields = { From: PATIENT_PHONE, To: '+15550001111', Body: '1' };
      const signature = expectedSignature(WEBHOOK_URL, fields);
      const response = await POST(inboundRequest(fields, signature));

      expect(response.status).toBe(200);
      const payload = (await response.json()) as { outcome: { status: string } };
      expect(payload.outcome.status).toBe('confirmed');

      const dose = db
        .prepare('SELECT adherence_status FROM daily_schedules WHERE id = ?')
        .get(earlyScheduleId) as { adherence_status: string };
      expect(dose.adherence_status).toBe('CONFIRMED');

      // Real-mode replies carry the real delivery mode for the outbox console.
      const modes = db
        .prepare(`SELECT delivery_mode FROM sms_outbox WHERE direction = 'outbound'`)
        .all() as { delivery_mode: string }[];
      expect(modes).toHaveLength(1);
      expect(modes[0].delivery_mode).toBe('real');
      expect(calls.every((url) => url.includes('api.twilio.com'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('validates the signature against the PUBLIC origin when SICKBAY_PUBLIC_BASE_URL is set (proxy port quirk)', async () => {
    // The WHATWG URL host setter keeps an existing port when the assigned
    // value carries none (http://localhost:3000 + host=public.host →
    // public.host:3000), which used to make every proxied signature fail.
    Object.assign(process.env, REAL_TWILIO_ENV);
    const savedPublicBase = process.env.SICKBAY_PUBLIC_BASE_URL;
    process.env.SICKBAY_PUBLIC_BASE_URL = 'https://sickbay.example';
    const { earlyScheduleId } = seedPatient();
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ sid: 'SMinbound-proxy-1' }), { status: 201 }),
      );
    }) as typeof fetch;

    try {
      // Request hits the internal dev-server URL; Twilio signed the public one.
      const fields = { From: PATIENT_PHONE, To: '+15550001111', Body: '1' };
      const publicUrl = 'https://sickbay.example/api/telephony/sms-inbound';
      const signature = expectedSignature(publicUrl, fields);
      const proxiedRequest = new NextRequest('http://localhost:3000/api/telephony/sms-inbound', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': signature,
        },
        body: new URLSearchParams(fields).toString(),
      });
      const response = await POST(proxiedRequest);

      expect(response.status).toBe(200); // NOT 403 — the internal port must not leak into the signed URL
      const dose = db
        .prepare('SELECT adherence_status FROM daily_schedules WHERE id = ?')
        .get(earlyScheduleId) as { adherence_status: string };
      expect(dose.adherence_status).toBe('CONFIRMED');
      expect(calls.every((url) => url.includes('api.twilio.com'))).toBe(true);
    } finally {
      if (savedPublicBase === undefined) delete process.env.SICKBAY_PUBLIC_BASE_URL;
      else process.env.SICKBAY_PUBLIC_BASE_URL = savedPublicBase;
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts an unsigned request in fixture mode (CI and offline demo)', async () => {
    // No TWILIO_* env: no auth token exists to verify against.
    const { earlyScheduleId } = seedPatient();

    const response = await POST(inboundRequest({ From: PATIENT_PHONE, Body: '1' }));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { outcome: { status: string } };
    expect(payload.outcome.status).toBe('confirmed');
    const dose = db
      .prepare('SELECT adherence_status FROM daily_schedules WHERE id = ?')
      .get(earlyScheduleId) as { adherence_status: string };
    expect(dose.adherence_status).toBe('CONFIRMED');
  });
});
