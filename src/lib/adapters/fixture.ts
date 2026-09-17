import crypto from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';
import { encryptPhoneNumber } from '@/lib/crypto/phone-crypto';
import type {
  DelayQueueAdapter,
  EscalationJob,
  LabelExtractionResult,
  SmsGatewayAdapter,
  SmsSendResult,
  VisionOcrAdapter,
} from './types';

/**
 * Deterministic fixture adapters (build spec, "System shape": adapters switch
 * between real services and deterministic fixtures on environment variables
 * alone).
 *
 * None of these touch the network. The vision fixture rotates a canned label
 * set whose confidence scores straddle the 0.70 gate so the low-confidence
 * modal (PRD §3) is demoable and testable; the SMS fixture appends to
 * sms_outbox so the demo console renders exactly what would hit a phone; the
 * delay-queue fixture writes the escalation_jobs row that a sweep tick later
 * dispatches.
 */

/**
 * OCR fixture set — confidence values deliberately straddle OCR_CONFIDENCE_GATE:
 * two auto-population reads (0.94, 0.71) and two low-confidence reads
 * (0.69, 0.42). Values are synthetic demo data; RxNorm resolution belongs to
 * the normalization engine, so rxcui stays null.
 */
const FIXTURE_LABELS: readonly LabelExtractionResult[] = [
  {
    brandName: 'Synthroid',
    genericName: 'levothyroxine',
    dosage: '50 mcg',
    instructionsRaw:
      'Take once daily in the morning on an empty stomach, 30 minutes to 1 hour before breakfast.',
    confidence: 0.94,
    highRiskSideEffects: [],
    rxcui: null,
  },
  {
    brandName: 'Tums',
    genericName: 'calcium carbonate',
    dosage: '1250 mg',
    instructionsRaw: 'Chew 2 tablets as needed for symptoms, up to 4 times daily.',
    confidence: 0.71,
    highRiskSideEffects: [],
    rxcui: null,
  },
  {
    brandName: 'Glucophage',
    genericName: 'metformin',
    dosage: '1000 mg',
    instructionsRaw: 'Take one tablet twice daily with meals.',
    confidence: 0.69,
    highRiskSideEffects: ['nausea'],
    rxcui: null,
  },
  {
    brandName: 'Zestril',
    genericName: 'lisinopril',
    dosage: '10 mg',
    instructionsRaw: 'Take one tablet by mouth once daily.',
    confidence: 0.42,
    highRiskSideEffects: ['dizziness', 'orthostasis'],
    rxcui: null,
  },
];

export interface FixtureVisionAdapterOptions {
  /** Offset into the rotation, so a test can hand itself a known fixture. */
  startIndex?: number;
}

/** Call N returns FIXTURE_LABELS[(startIndex + N) mod 4] — deterministic. */
export function createFixtureVisionAdapter(
  options: FixtureVisionAdapterOptions = {},
): VisionOcrAdapter {
  let cursor = options.startIndex ?? 0;
  return {
    // No imageUrl use: fixtures read nothing, so the parameter is dropped
    // (a narrower parameter list still satisfies VisionOcrAdapter).
    extractLabel(): Promise<LabelExtractionResult> {
      const label = FIXTURE_LABELS[cursor % FIXTURE_LABELS.length];
      cursor += 1;
      return Promise.resolve(label);
    },
  };
}

export interface FixtureSmsAdapterOptions {
  db: SqliteDb;
  /** Resolves the AES-256-GCM key at send time (repo rule: never raw at rest). */
  encryptionKey: () => Buffer;
  /** Clock injection for deterministic timestamps under test. */
  now?: () => Date;
}

/** Appends every outbound message to sms_outbox with delivery_mode='fixture'. */
export function createFixtureSmsAdapter(options: FixtureSmsAdapterOptions): SmsGatewayAdapter {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  return {
    async send(to: string, body: string, mediaUrl?: string): Promise<SmsSendResult> {
      const messageId = `fixture_${crypto.randomUUID()}`;
      db.prepare(
        `INSERT INTO sms_outbox
           (id, direction, recipient_encrypted, body, media_url, provider_message_id, delivery_mode, created_at)
         VALUES (?, 'outbound', ?, ?, ?, ?, 'fixture', ?)`,
      ).run(
        crypto.randomUUID(),
        encryptPhoneNumber(to, options.encryptionKey()),
        body,
        mediaUrl ?? null,
        messageId,
        now().toISOString(),
      );
      return { messageId };
    },
  };
}

export interface FixtureDelayQueueAdapterOptions {
  db: SqliteDb;
  now?: () => Date;
}

/**
 * enqueue = a durable pending escalation_jobs row (FK-checked against the
 * schedule and profile). The sweep reads rows with status='pending' and
 * deliver_at <= now, so restarts never lose an escalation.
 */
export function createFixtureDelayQueueAdapter(
  options: FixtureDelayQueueAdapterOptions,
): DelayQueueAdapter {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  return {
    async enqueue(payload: EscalationJob, deliverAt: Date): Promise<{ id: string }> {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO escalation_jobs
           (id, daily_schedule_id, profile_id, deliver_at, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
      ).run(
        id,
        payload.dailyScheduleId,
        payload.profileId,
        deliverAt.toISOString(),
        now().toISOString(),
      );
      return { id };
    },
  };
}
