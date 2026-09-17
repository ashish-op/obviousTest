/**
 * Live-credentials E2E smoke (final integration pass).
 *
 * NOT a vitest test — it sends real SMS and calls real APIs, so it refuses to
 * run without credentials (CI has none and must never reach out; the vitest
 * suite covers this same flow with fixtures). Drives the RUNNING dev server
 * over HTTP so the whole integrated surface is exercised the way a phone and
 * a browser would see it:
 *
 *   upload photos → real ConcentrateAI extraction → medications →
 *   schedule regenerate (buffer solver) → escalation sweep (real caregiver
 *   SMS) → signed inbound confirm/DIZZY → unsigned reject → reconciliation
 *   PDF → database + Twilio delivery verification.
 *
 * Usage:
 *   npm run dev (another terminal), then:
 *   npm run smoke:e2e -- [baseUrl] [photo1 photo2 ...]
 *   baseUrl defaults to http://localhost:3000
 *
 * Real-mode requires a publicly fetchable origin for extraction URLs; pass
 * the public preview URL as baseUrl when running against the tunnel.
 * Re-running is additive (more meds/doses/messages); reset first with
 * `rm -rf data && npm run db:init` for a clean run.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decryptPhoneNumber, loadEncryptionKey } from '../lib/crypto/phone-crypto';
import { loadDotEnv } from './load-dot-env';

loadDotEnv();
const key = loadEncryptionKey();

const BASE_URL = process.argv[2] ?? 'http://localhost:3000';
const photoArgs = process.argv.slice(3);
const PHOTOS =
  photoArgs.length > 0
    ? photoArgs
    : [
        path.join(process.cwd(), 'scripts/fixtures/real-bottle/tylenol.jpg'),
        path.join(process.cwd(), 'scripts/fixtures/real-bottle/walgreens.jpg'),
      ];

const required = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'CONCENTRATEAI_API_KEY',
] as const;
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `e2e-smoke: missing real credentials: ${missing.join(', ')}. This script sends real SMS and calls real APIs — it must not run in fixture mode. CI is credential-free by contract.`,
  );
  process.exit(1);
}

const twilioSid = process.env.TWILIO_ACCOUNT_SID as string;
const twilioToken = process.env.TWILIO_AUTH_TOKEN as string;
// The destination the demo was seeded with (DEMO_* phones): the Twilio
// account's verified caller ID, so every SMS leg reaches a real phone.
// TWILIO_FROM_NUMBER is the SENDER — a different number.
const CAREGIVER_NUMBER = (process.env.DEMO_CAREGIVER_PHONE ?? process.env.TWILIO_FROM_NUMBER) as string;

/** E.164-normalize for comparisons (Twilio params and decrypted values both carry `+`). */
const normalizePhone = (value: string): string => `+${value.replace(/[^\d]/g, '')}`;

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: string): boolean => {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};

const section = (title: string): void => console.log(`\n== ${title} ==`);

async function getJson(pathname: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE_URL}${pathname}`);
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function postJson(pathname: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * X-Twilio-Signature for the inbound webhook: HMAC-SHA1 over the full URL plus
 * POST params concatenated in alphabetical name order, base64 — the exact
 * algorithm the adapter validates (src/lib/adapters/twilio.ts).
 */
function twilioSignature(url: string, params: Record<string, string>): string {
  const canonical =
    url +
    Object.keys(params)
      .sort()
      .map((name) => name + params[name])
      .join('');
  return crypto.createHmac('sha1', twilioToken).update(canonical, 'utf8').digest('base64');
}

async function postInbound(params: Record<string, string>, sign: boolean): Promise<Response> {
  const url = `${BASE_URL}/api/telephony/sms-inbound`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(sign ? { 'X-Twilio-Signature': twilioSignature(url, params) } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
}

/** Twilio's delivery status for one outbound message SID. */
async function twilioMessageStatus(sid: string): Promise<string> {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages/${sid}.json`,
    { headers: { Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64')}` } },
  );
  if (!response.ok) return `http_${response.status}`;
  const payload = (await response.json()) as { status?: unknown };
  return typeof payload.status === 'string' ? payload.status : 'unknown';
}

interface ExtractionSucceeded {
  imageUrl: string;
  status: 'succeeded';
  gate: 'auto_populate' | 'low_confidence';
  extraction: {
    brandName: string | null;
    genericName: string;
    dosage: string;
    instructionsRaw: string;
    confidence: number;
    highRiskSideEffects: string[];
    rxcui: string | null;
  };
  rxnorm: { rxcui: string; name: string } | null;
  highRiskSideEffects: string[];
}

interface ExtractionFailed {
  imageUrl: string;
  status: 'failed';
  reason: string;
}

type ExtractOutcome = ExtractionSucceeded | ExtractionFailed;

const isSucceeded = (outcome: ExtractOutcome): outcome is ExtractionSucceeded =>
  outcome.status === 'succeeded';

async function main(): Promise<number> {
  section('1. Server reachability');
  {
    const response = await fetch(BASE_URL).catch(() => null);
    check(`GET ${BASE_URL} responds`, response !== null && response.ok);
    if (!response || !response.ok) {
      console.error('Dev server is not reachable — start it with `npm run dev` first.');
      process.exit(1);
    }
  }

  // ---- 2. Upload + real extraction ----
  const outcomes: ExtractOutcome[] = [];
  const uploadedUrls: string[] = [];
  {
    section('2. Photo upload → real ConcentrateAI extraction');
    const form = new FormData();
    for (const photoPath of PHOTOS) {
      const bytes = readFileSync(photoPath);
      form.append('photos', new Blob([bytes], { type: 'image/jpeg' }), path.basename(photoPath));
    }
    const uploadResponse = await fetch(`${BASE_URL}/api/ingest/upload`, { method: 'POST', body: form });
    const uploadOk = check(
      'POST /api/ingest/upload accepts both real bottle photos',
      uploadResponse.status === 201,
      `status ${uploadResponse.status}`,
    );
    if (uploadOk) {
      const payload = (await uploadResponse.json()) as { uploads: { url: string; originalName: string }[] };
      uploadedUrls.push(...payload.uploads.map((u) => u.url));
      check(
        'upload URLs are absolute (fetchable by the vision provider)',
        uploadedUrls.every((u) => u.startsWith('http')),
        uploadedUrls.join(', '),
      );
      const extract = await postJson('/api/ingest/extract', { imageUrls: uploadedUrls });
      const body = extract.body as { outcomes?: ExtractOutcome[] } | null;
      check(
        'POST /api/ingest/extract returns one outcome per photo',
        extract.status === 200 && Array.isArray(body?.outcomes) && body!.outcomes!.length === PHOTOS.length,
      );
      outcomes.push(...(body?.outcomes ?? []));

      const succeeded = outcomes.filter(isSucceeded);
      const failedOutcomes = outcomes.filter((o) => !isSucceeded(o));
      const realMode =
        succeeded.length > 0 &&
        !succeeded.some(
          (o) =>
            o.extraction.genericName === 'levothyroxine' && o.extraction.confidence === 0.94,
        );
      check(
        'extraction ran in REAL mode (not the canned fixture set)',
        realMode,
        realMode ? undefined : 'fixture fingerprints found',
      );
      for (const outcome of failedOutcomes) {
        failed += 1;
        console.log(`  ❌ extraction failed for ${path.basename(new URL(outcome.imageUrl).pathname)} — ${outcome.reason}`);
      }
      for (const outcome of succeeded) {
        const which = path.basename(new URL(outcome.imageUrl).pathname);
        const rx = outcome.rxnorm ? `${outcome.rxnorm.rxcui} (${outcome.rxnorm.name})` : 'null (flagged for manual entry)';
        console.log(
          `    ${which}: generic=${outcome.extraction.genericName}, dosage=${outcome.extraction.dosage}, ` +
            `confidence=${outcome.extraction.confidence.toFixed(2)}, gate=${outcome.gate}, ` +
            `sideEffects=[${outcome.highRiskSideEffects.join(', ')}], rxnorm=${rx}`,
        );
      }
    }
  }

  // ---- 3. Medications (two real RxNorm entries + the real OCR read) ----
  {
    section('3. Medications (RxNorm normalization + OCR-sourced card)');
    const tylenol = outcomes.find(
      (o): o is ExtractionSucceeded =>
        isSucceeded(o) && /acetaminophen|tylenol/i.test(o.extraction.genericName),
    );
    const entries: {
      label: string;
      body: Record<string, unknown>;
      groundTruth?: RegExp;
    }[] = [
      {
        label: 'levothyroxine (manual)',
        body: {
          brandName: 'Synthroid',
          genericName: 'levothyroxine',
          dosage: '50 mcg',
          instructionsRaw: 'Take once daily in the morning on an empty stomach.',
          rxcui: '11289',
          highRiskSideEffects: [],
          source: 'manual',
          bufferType: null,
          minBufferMinutes: null,
        },
        groundTruth: /levothyroxine/i,
      },
      {
        label: 'calcium carbonate (manual)',
        body: {
          brandName: 'Caltrate',
          genericName: 'calcium carbonate',
          dosage: '1250 mg',
          instructionsRaw: 'Take 1 tablet twice daily with food.',
          rxcui: '21925',
          highRiskSideEffects: [],
          source: 'manual',
          bufferType: null,
          minBufferMinutes: null,
        },
        groundTruth: /calcium/i,
      },
      {
        label: 'lisinopril (manual, dizziness flagged)',
        body: {
          brandName: 'Zestril',
          genericName: 'lisinopril',
          dosage: '10 mg',
          instructionsRaw: 'Take one tablet by mouth daily.',
          rxcui: '29046',
          highRiskSideEffects: ['dizziness'],
          source: 'manual',
          bufferType: null,
          minBufferMinutes: null,
        },
        groundTruth: /lisinopril/i,
      },
      ...(tylenol
        ? [
            {
              label: `acetaminophen (source=ocr, live confidence ${tylenol.extraction.confidence.toFixed(2)})`,
              body: {
                brandName: tylenol.extraction.brandName,
                genericName: tylenol.extraction.genericName,
                dosage: tylenol.extraction.dosage,
                instructionsRaw: tylenol.extraction.instructionsRaw,
                rxcui: tylenol.extraction.rxcui,
                highRiskSideEffects: tylenol.extraction.highRiskSideEffects,
                source: 'ocr',
                extractionConfidence: tylenol.extraction.confidence,
                bufferType: null,
                minBufferMinutes: null,
              },
            },
          ]
        : []),
    ];

    for (const entry of entries) {
      const response = await postJson('/api/medications', entry.body);
      const med = response.body as { genericName?: string } | null;
      check(`POST /api/medications — ${entry.label}`, response.status === 201, `status ${response.status}`);
      if (entry.groundTruth && med) {
        check(`  ${entry.label} names ground truth`, entry.groundTruth.test(med.genericName ?? ''), med.genericName ?? '(none)');
      }
    }
  }

  // ---- 4. Schedule (buffer solver, PRD §4 worked case) ----
  {
    section('4. Schedule shift — PRD §4 worked case (wake → 09:30, buffer push)');
    const regen = await postJson('/api/schedule/regenerate', {});
    check('POST /api/schedule/regenerate', regen.status === 200, `status ${regen.status}`);

    // The buffer push is a SHIFT-time rule (tests/schedule-solver.test.ts):
    // the initial anchor gap (07:00 → 08:00, 60 min) is preserved on
    // generation, and the solver pushes calcium forward only when the routine
    // shift re-enforces prerequisites. PRD §4 worked case: wake 07:00 → 09:30.
    const shift = await postJson('/api/schedule/shift', { wakeTime: '09:30' });
    check('POST /api/schedule/shift {"wakeTime":"09:30"}', shift.status === 200, `status ${shift.status}`);
    const doses = ((shift.body as { doses?: { medicationName: string; scheduledFor: string; adherenceStatus: string; deferredReason: string | null; isPastBedtimeWarning: boolean }[] }).doses ?? []);
    for (const dose of doses) {
      console.log(
        `    ${dose.scheduledFor.slice(11, 16)}  ${dose.medicationName.padEnd(18)} ${dose.adherenceStatus}` +
          `${dose.deferredReason ? ` (${dose.deferredReason})` : ''}${dose.isPastBedtimeWarning ? ' ⏰bedtime' : ''}`,
      );
    }
    const levo = doses.find((d) => /levothyroxine/i.test(d.medicationName));
    const calcium = doses.find((d) => /calcium/i.test(d.medicationName));
    if (levo && calcium) {
      const gapMinutes =
        (new Date(calcium.scheduledFor).getTime() - new Date(levo.scheduledFor).getTime()) / 60000;
      check('calcium pushed to ≥2 h from levothyroxine after shift', gapMinutes >= 120, `gap ${gapMinutes} min`);
      // The push itself is asserted by the gap: regenerate already enforces
      // the buffer at generation time (delta 0 → buffer_push), so a later
      // shift usually lands the pair at exactly 120 min under a wake_shift
      // marker. Either marker is valid; the enforced gap is the invariant.
      check(
        'calcium dose carries a valid deferred marker',
        calcium.deferredReason === 'buffer_push' || calcium.deferredReason === 'wake_shift',
        `reason=${calcium.deferredReason}`,
      );
    } else {
      check('both levothyroxine and calcium have dose rows', false);
    }
  }

  /**
   * Run a small read-only SQLite probe against data/sickbay.db and return the
   * JSON it prints. (The outbox has no JSON API route — the demo console renders
   * it server-side — so the smoke reads it the same way the page does.)
   */
  function sqliteProbe(script: string): unknown {
    const result = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`sqlite probe failed: ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
  }

  // ---- 5. Signed inbound loop (confirm pending doses before the sweep) ----
  {
    section('5. Signed inbound SMS — confirm then DIZZY YES');
    const patientNumber = normalizePhone(process.env.DEMO_PROFILE_PHONE ?? process.env.TWILIO_FROM_NUMBER ?? '');
    const inboundParams = {
      From: patientNumber,
      To: patientNumber,
      Body: '1',
      MessageSid: `SM${crypto.randomBytes(16).toString('hex')}`,
    };
    // Confirm three pending doses (levothyroxine, lisinopril, morning calcium):
    // the symptom check-in needs a CONFIRMED dizziness-flagged dose to
    // attribute DIZZY YES to, and confirming first keeps the later sweep from
    // escalating doses a real patient would have taken on schedule.
    for (let i = 1; i <= 3; i += 1) {
      const confirm = await postInbound(
        { ...inboundParams, MessageSid: `SM${crypto.randomBytes(16).toString('hex')}` },
        true,
      );
      check(`signed "1" accepted (dose ${i})`, confirm.ok, `status ${confirm.status}`);
    }

    const schedule = await getJson('/api/schedule');
    const confirmedCount = ((schedule.body as { doses?: { adherenceStatus: string }[] }).doses ?? []).filter(
      (d) => d.adherenceStatus === 'CONFIRMED',
    ).length;
    check('three doses now CONFIRMED', confirmedCount >= 3, `confirmed=${confirmedCount}`);

    const dizzy = await postInbound(
      { From: inboundParams.From, Body: 'DIZZY YES', MessageSid: `SM${crypto.randomBytes(16).toString('hex')}` },
      true,
    );
    check('signed "DIZZY YES" accepted', dizzy.ok, `status ${dizzy.status}`);
    const sideEffects = sqliteProbe(`
const Database = require('better-sqlite3');
const db = new Database('data/sickbay.db', { readonly: true });
console.log(JSON.stringify(db.prepare("SELECT COUNT(*) n FROM side_effect_logs WHERE reported_via='sms'").get()));
`) as { n: number };
    check('DIZZY YES persisted a side_effect_logs row', sideEffects.n > 0, `n=${sideEffects.n}`);

    const unsigned = await postInbound({ From: inboundParams.From, Body: '1' }, false);
    check('unsigned inbound rejected with 403', unsigned.status === 403, `status ${unsigned.status}`);
  }

  // ---- 6. Escalation sweep (real caregiver SMS for the remaining pending dose) ----
  const outboundSids: string[] = [];
  {
    section('6. Escalation sweep → real caregiver SMS');
    const sweep = await postJson('/api/telephony/sweep', {});
    const body = sweep.body as { outcome?: { dispatchedJobs?: number; backfilledJobs?: number; cancelledJobs?: number } } | null;
    check(
      'POST /api/telephony/sweep dispatches due escalations',
      sweep.status === 200 && (body?.outcome?.dispatchedJobs ?? 0) > 0,
      `dispatched=${body?.outcome?.dispatchedJobs} backfilled=${body?.outcome?.backfilledJobs} cancelled=${body?.outcome?.cancelledJobs}`,
    );

    const outbox = sqliteProbe(`
const Database = require('better-sqlite3');
const db = new Database('data/sickbay.db', { readonly: true });
console.log(JSON.stringify(db.prepare("SELECT recipient_encrypted, body, provider_message_id FROM sms_outbox WHERE direction='outbound' AND delivery_mode='real' ORDER BY created_at").all()));
`) as { recipient_encrypted: string; body: string; provider_message_id: string | null }[];
    check('sms_outbox holds real-mode outbound (caregiver) messages', outbox.length > 0, `${outbox.length} rows`);
    for (const row of outbox) {
      if (row.provider_message_id) outboundSids.push(row.provider_message_id);
      console.log(`    → ${decryptPhoneNumber(row.recipient_encrypted, key)}: ${row.body.slice(0, 70)}`);
    }
    const normalizedCaregiver = normalizePhone(CAREGIVER_NUMBER);
    check(
      'caregiver escalation went to the verified test number',
      outbox.every((row) => normalizePhone(decryptPhoneNumber(row.recipient_encrypted, key)) === normalizedCaregiver),
      `expected ${normalizedCaregiver}`,
    );
  }


  // ---- 7. Reconciliation PDF ----
  {
    section('7. Reconciliation PDF export');
    const response = await fetch(`${BASE_URL}/api/reconciliation/pdf`);
    const buffer = Buffer.from(await response.arrayBuffer());
    check('GET /api/reconciliation/pdf returns a PDF', response.ok && buffer.subarray(0, 4).toString() === '%PDF', `${buffer.byteLength} bytes`);

    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const text = (await parser.getText()).text.replace(/\s+/g, ' ');
      check('PDF: Dose Timeline section', text.includes('Dose Timeline'));
      check('PDF: Side Effects section', text.includes('Side Effects'));
      check('PDF: Detected Timing Conflicts section', text.includes('Detected Timing Conflicts'));
      check('PDF: Clinical Notice section', text.includes('Clinical Notice'));
      check(
        'PDF: scope disclaimer text present',
        text.includes('does not recommend, alter, or validate any prescription'),
      );
    } finally {
      await parser.destroy();
    }
    const outPath = process.env.SMOKE_PDF_PATH ?? '/home/user/work/evidence/reconciliation-live.pdf';
    writeFileSync(outPath, buffer);
    console.log(`    saved ${outPath}`);
  }

  // ---- 8. Database verification + Twilio delivery ----
  {
    section('8. Database + Twilio delivery verification');
    const db = sqliteProbe(`
  const Database = require('better-sqlite3');
  const db = new Database('data/sickbay.db', { readonly: true });
  const statuses = db.prepare('SELECT adherence_status, COUNT(*) n FROM daily_schedules GROUP BY adherence_status').all();
  const realOutbox = db.prepare("SELECT COUNT(*) n FROM sms_outbox WHERE direction='outbound' AND delivery_mode='real' AND provider_message_id IS NOT NULL").get();
  const realInbound = db.prepare("SELECT COUNT(*) n FROM sms_outbox WHERE delivery_mode='real' AND direction='inbound'").get();
  const sideEffects = db.prepare("SELECT COUNT(*) n FROM side_effect_logs WHERE reported_via='sms'").get();
  const audits = db.prepare("SELECT COUNT(*) n FROM audit_logs").get();
  const jobs = db.prepare("SELECT status, COUNT(*) n FROM escalation_jobs GROUP BY status").all();
  console.log(JSON.stringify({ statuses, realOutbox: realOutbox.n, realInbound: realInbound.n, sideEffects: sideEffects.n, audits: audits.n, jobs }));
  `) as {
      statuses: { adherence_status: string; n: number }[];
      realOutbox: number;
      realInbound: number;
      sideEffects: number;
      audits: number;
      jobs: { status: string; n: number }[];
    };

    check('escalation_jobs dispatched rows exist', (db.jobs.find((j) => j.status === 'dispatched')?.n ?? 0) > 0, JSON.stringify(db.jobs));
    check('side_effect_logs has the SMS-reported dizziness row', db.sideEffects > 0, `n=${db.sideEffects}`);
    check('audit_logs rows written (pdf export)', db.audits > 0, `n=${db.audits}`);
    check('all real outbox rows carry a provider message SID', db.realOutbox === outboundSids.length && db.realOutbox > 0, `outbox=${db.realOutbox}, sids=${outboundSids.length}`);
    check('inbound SMS rows persisted in real mode', db.realInbound >= 3, `n=${db.realInbound}`);
    console.log(`    dose statuses: ${db.statuses.map((s) => `${s.adherence_status}=${s.n}`).join(', ')}`);

    for (const sid of outboundSids) {
      const status = await twilioMessageStatus(sid);
      check(`Twilio message ${sid.slice(0, 10)}…`, status !== 'failed', `status=${status}`);
    }
  }

  console.log(`\n=== SMOKE SUMMARY: ${passed} passed, ${failed} failed ===`);

  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });