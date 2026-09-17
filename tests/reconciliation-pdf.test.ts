/**
 * Physician advocacy PDF content assertions (PRD §7 acceptance):
 *
 * 1. A pure-fixture render: all four sections present in order, the red-flag
 *    symptom line carries its reconciliation prompt, the conflict row names
 *    buffer minutes, and the clinical notice closes the report. The 16pt
 *    body contract is pinned on the named style constant — pdf-parse extracts
 *    text, not font metrics.
 * 2. The export route end-to-end: seeded medications (levothyroxine + calcium
 *    carbonate), a confirmed and a pending dose, and one severity-4 dizziness
 *    report render through GET /api/reconciliation/pdf into a parseable PDF,
 *    with an audit_logs row written per export. A cleared schedule still
 *    renders a complete report rather than failing.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { PDFParse } from 'pdf-parse';
import { buildSideEffectTimeline } from '@/lib/engines/red-flag-timeline';
import { buildReconciliationPdfData } from '@/lib/reconciliation/data';
import {
  CLINICAL_NOTICE,
  PDF_BODY_FONT_SIZE,
  PDF_STYLES,
  SECTION_TITLE_CONFLICTS,
  SECTION_TITLE_NOTICE,
  SECTION_TITLE_SIDE_EFFECTS,
  SECTION_TITLE_TIMELINE,
} from '@/lib/reconciliation/pdf-document';
import { renderReconciliationPdf } from '@/lib/reconciliation/render';
import { TEST_KEY_HEX } from './helpers';

// The route resolves its store through getDb() at call time; pin the temp DB
// BEFORE the route module loads so the singleton lands on the test database
// (same pattern as tests/sms-inbound.test.ts).
const routeDbDir = mkdtempSync(path.join(tmpdir(), 'sickbay-pdf-'));
process.env.SICKBAY_DB_PATH = path.join(routeDbDir, 'route.db');
process.env.PHONE_ENCRYPTION_KEY = TEST_KEY_HEX;

const { GET } = await import('@/app/api/reconciliation/pdf/route');
const { getDb } = await import('@/lib/db/connection');
const { DEMO_PROFILE_ID, seedDemoProfile } = await import('@/lib/db/seed');
const { RECONCILIATION_PDF_EXPORT_ACTION } = await import('@/lib/audit');

/** Whitespace-normalized text of a rendered PDF buffer. */
async function extractText(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    const result = await parser.getText();
    return result.text.replace(/\s+/g, ' ');
  } finally {
    await parser.destroy();
  }
}

// ---- Fixture data: PRD §4 worked case + a red-flagged dizziness report ----

const GENERATED_AT = '2026-09-17T18:00:00.000Z';

function fixtureMedications() {
  return [
    {
      id: 'med-levo',
      genericName: 'levothyroxine',
      dosage: '50 mcg',
      instructionsRaw: 'Take on an empty stomach.',
      rxcui: '11289',
    },
    {
      id: 'med-calcium',
      genericName: 'calcium carbonate',
      dosage: '500 mg',
      instructionsRaw: 'Take with food.',
      rxcui: '21925',
    },
    {
      id: 'med-lisinopril',
      genericName: 'lisinopril',
      dosage: '10 mg',
      instructionsRaw: 'Take once daily.',
      rxcui: '29046',
    },
  ];
}

function fixtureTimeline() {
  const doses = [
    {
      id: 'dose-levo',
      medicationId: 'med-levo',
      medicationName: 'levothyroxine',
      scheduledFor: '2026-09-17T07:00:00.000Z',
      adherenceStatus: 'CONFIRMED' as const,
      highRiskSideEffects: [] as string[],
    },
    {
      id: 'dose-calcium',
      medicationId: 'med-calcium',
      medicationName: 'calcium carbonate',
      scheduledFor: '2026-09-17T09:30:00.000Z',
      adherenceStatus: 'PENDING' as const,
      highRiskSideEffects: [] as string[],
    },
    {
      id: 'dose-lisinopril',
      medicationId: 'med-lisinopril',
      medicationName: 'lisinopril',
      scheduledFor: '2026-09-17T12:00:00.000Z',
      adherenceStatus: 'PENDING' as const,
      highRiskSideEffects: ['dizziness'],
    },
  ];
  const logs = [
    {
      id: 'log-dizzy',
      dailyScheduleId: 'dose-lisinopril',
      symptom: 'dizziness',
      severity: 4,
      reportedAt: '2026-09-17T13:05:00.000Z',
    },
    {
      id: 'log-denied',
      dailyScheduleId: 'dose-levo',
      symptom: 'nausea',
      severity: 1,
      reportedAt: '2026-09-17T07:20:00.000Z',
    },
  ];
  return buildSideEffectTimeline(doses, logs);
}

describe('physician advocacy PDF — fixture render content (PRD §7)', () => {
  let text: string;

  beforeEach(async () => {
    const data = buildReconciliationPdfData({
      patientName: 'Robert Sharma',
      generatedAt: GENERATED_AT,
      medications: fixtureMedications(),
      timeline: fixtureTimeline(),
    });
    text = await extractText(await renderReconciliationPdf(data));
  });

  it('renders all four sections, in PRD §7 order', () => {
    expect(text).toContain(SECTION_TITLE_TIMELINE);
    expect(text).toContain(SECTION_TITLE_SIDE_EFFECTS);
    expect(text).toContain(SECTION_TITLE_CONFLICTS);
    expect(text).toContain(SECTION_TITLE_NOTICE);
    expect(text.indexOf(SECTION_TITLE_TIMELINE)).toBeLessThan(text.indexOf(SECTION_TITLE_SIDE_EFFECTS));
    expect(text.indexOf(SECTION_TITLE_SIDE_EFFECTS)).toBeLessThan(text.indexOf(SECTION_TITLE_CONFLICTS));
    expect(text.indexOf(SECTION_TITLE_CONFLICTS)).toBeLessThan(text.indexOf(SECTION_TITLE_NOTICE));
  });

  it('prints the patient header and dose timeline with adherence', () => {
    expect(text).toContain('Patient: Robert Sharma');
    expect(text).toContain('07:00');
    expect(text).toContain('levothyroxine — 50 mcg · Confirmed');
    expect(text).toContain('calcium carbonate — 500 mg · Pending');
  });

  it('flags the reported symptom with its reconciliation prompt', () => {
    expect(text).toContain('lisinopril: dizziness — severity 4/5');
    expect(text).toContain(
      'Assess dizziness with lisinopril — reported severity 4/5. Consider medication reconciliation.',
    );
  });

  it('shows a denied check-in without a reconciliation prompt', () => {
    expect(text).toContain('levothyroxine: nausea — severity 1/5');
    expect(text).not.toContain('Assess nausea with levothyroxine');
  });

  it('lists the detected chemical/absorption conflict with buffer minutes', () => {
    expect(text).toContain('levothyroxine + calcium carbonate');
    expect(text).toContain('absorption buffer: 120 minutes apart');
  });

  it('closes with the clinical notice', () => {
    expect(text).toContain(CLINICAL_NOTICE);
    expect(text.lastIndexOf(CLINICAL_NOTICE)).toBeGreaterThan(text.indexOf(SECTION_TITLE_NOTICE));
  });

  it('pins the 16pt body contract on the style constant', () => {
    expect(PDF_BODY_FONT_SIZE).toBe(16);
    expect(PDF_STYLES.page.fontSize).toBe(PDF_BODY_FONT_SIZE);
  });
});

describe('GET /api/reconciliation/pdf — seeded-data export route', () => {
  const db = getDb();
  seedDemoProfile(db);

  const levoId = '11111111-1111-4111-8111-111111111111';
  const calciumId = '22222222-2222-4222-8222-222222222222';
  const levoDoseId = '33333333-3333-4333-8333-333333333333';
  const calciumDoseId = '44444444-4444-4444-8444-444444444444';

  function seedReconciliationData(): void {
    db.prepare(
      `INSERT INTO medications (id, profile_id, generic_name, dosage, instructions_raw, rxcui)
       VALUES (?, ?, 'levothyroxine', '50 mcg', 'Take on an empty stomach.', '11289')`,
    ).run(levoId, DEMO_PROFILE_ID);
    db.prepare(
      `INSERT INTO medications (id, profile_id, generic_name, dosage, instructions_raw, rxcui)
       VALUES (?, ?, 'calcium carbonate', '500 mg', 'Take with food.', '21925')`,
    ).run(calciumId, DEMO_PROFILE_ID);
    db.prepare(
      `INSERT INTO daily_schedules (id, profile_id, medication_id, scheduled_for, adherence_status)
       VALUES (?, ?, ?, '2026-09-17T07:00:00.000Z', 'CONFIRMED')`,
    ).run(levoDoseId, DEMO_PROFILE_ID, levoId);
    db.prepare(
      `INSERT INTO daily_schedules (id, profile_id, medication_id, scheduled_for, adherence_status)
       VALUES (?, ?, ?, '2026-09-17T09:30:00.000Z', 'PENDING')`,
    ).run(calciumDoseId, DEMO_PROFILE_ID, calciumId);
    db.prepare(
      `INSERT INTO side_effect_logs (id, profile_id, medication_id, daily_schedule_id, symptom, severity, reported_via, reported_at)
       VALUES ('55555555-5555-4555-8555-555555555555', ?, ?, ?, 'dizziness', 4, 'sms', '2026-09-17T07:45:00.000Z')`,
    ).run(DEMO_PROFILE_ID, levoId, levoDoseId);
  }

  function exportRequest(): NextRequest {
    return new NextRequest('https://sickbay.example/api/reconciliation/pdf', { method: 'GET' });
  }

  it('renders a parseable PDF from seeded rows and audits the export', async () => {
    seedReconciliationData();

    const response = await GET(exportRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="reconciliation-report-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );

    const text = await extractText(Buffer.from(await response.arrayBuffer()));
    expect(text).toContain(SECTION_TITLE_TIMELINE);
    expect(text).toContain('levothyroxine — 50 mcg · Confirmed');
    expect(text).toContain('absorption buffer: 120 minutes apart');
    expect(text).toContain('Assess dizziness with levothyroxine');
    expect(text).toContain(CLINICAL_NOTICE);

    const auditRow = db
      .prepare('SELECT action FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT 1')
      .get(RECONCILIATION_PDF_EXPORT_ACTION) as { action: string } | undefined;
    expect(auditRow?.action).toBe(RECONCILIATION_PDF_EXPORT_ACTION);
  });

  it('renders an empty-schedule report rather than failing', async () => {
    db.exec('DELETE FROM side_effect_logs; DELETE FROM daily_schedules; DELETE FROM medications;');

    const response = await GET(exportRequest());

    expect(response.status).toBe(200);
    const text = await extractText(Buffer.from(await response.arrayBuffer()));
    expect(text).toContain('No side effects reported.');
    expect(text).toContain('No seeded interaction conflicts');
    expect(text).toContain(CLINICAL_NOTICE);
  });
});
