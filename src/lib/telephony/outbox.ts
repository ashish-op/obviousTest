/**
 * sms_outbox persistence + profile lookup for the two-way SMS loop (PRD §5).
 *
 * Every message — inbound or outbound, fixture or real — lands in sms_outbox
 * (build spec: "the demo console renders what would hit a phone"). Phone
 * numbers are stored only as AES-256-GCM envelopes; the console decrypts
 * server-side and displays a masked form (PRD §8).
 */

import crypto from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';
import { decryptPhoneNumber, encryptPhoneNumber } from '@/lib/crypto/phone-crypto';

export type SmsDeliveryMode = 'real' | 'fixture';
export type SmsDirection = 'inbound' | 'outbound';

export interface SmsOutboxRecord {
  id: string;
  direction: SmsDirection;
  /** Decrypted + masked for display; null when the envelope is unreadable. */
  maskedNumber: string | null;
  body: string;
  mediaUrl: string | null;
  providerMessageId: string | null;
  deliveryMode: SmsDeliveryMode;
  relatedDailyScheduleId: string | null;
  createdAt: string;
}

interface OutboxRow {
  id: string;
  direction: 'inbound' | 'outbound';
  recipient_encrypted: string | null;
  sender: string | null;
  body: string;
  media_url: string | null;
  provider_message_id: string | null;
  delivery_mode: 'real' | 'fixture';
  related_daily_schedule_id: string | null;
  created_at: string;
}

/**
 * Append an inbound message row. `senderEnvelope` is the ALREADY-ENCRYPTED
 * sender phone — callers encrypt before calling; nothing raw is persisted.
 */
export function recordInboundSms(
  db: SqliteDb,
  input: {
    profileId: string | null;
    senderEnvelope: string | null;
    body: string;
    providerMessageId: string | null;
    deliveryMode: SmsDeliveryMode;
    relatedDailyScheduleId?: string | null;
    now: Date;
  },
): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO sms_outbox
       (id, profile_id, direction, sender, body, provider_message_id, delivery_mode, related_daily_schedule_id, created_at)
     VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.profileId,
    input.senderEnvelope,
    input.body,
    input.providerMessageId,
    input.deliveryMode,
    input.relatedDailyScheduleId ?? null,
    input.now.toISOString(),
  );
  return id;
}

/** Link an outbound row (matched by provider message id) to the dose it concerns. */
export function linkOutboxRowToSchedule(
  db: SqliteDb,
  providerMessageId: string,
  dailyScheduleId: string,
): void {
  db.prepare(
    'UPDATE sms_outbox SET related_daily_schedule_id = ? WHERE provider_message_id = ? AND related_daily_schedule_id IS NULL',
  ).run(dailyScheduleId, providerMessageId);
}

/**
 * Resolve a sender phone to its profile by decrypting each stored envelope.
 * The demo database is small; when it grows this becomes an indexed
 * deterministic-ciphertext column (keyed hash), not a scan.
 */
export function findProfileIdByPhone(db: SqliteDb, phone: string, key: Buffer): string | null {
  const rows = db
    .prepare('SELECT id, phone_encrypted FROM profiles')
    .all() as { id: string; phone_encrypted: string }[];
  const matched = rows.find((row) => {
    try {
      return decryptPhoneNumber(row.phone_encrypted, key) === phone;
    } catch {
      // An undecryptable envelope must not break the scan — skip it. Corrupt
      // rows still surface: the console masks them as "(unreadable)".
      return false;
    }
  });
  return matched?.id ?? null;
}

export interface ProfileSmsContext {
  id: string;
  fullName: string;
  phone: string;
  caregiverPhone: string | null;
}

/** Load a profile with decrypted phone + caregiver phone (escalation needs both). */
export function loadProfileSmsContext(db: SqliteDb, profileId: string, key: Buffer): ProfileSmsContext | null {
  const row = db
    .prepare('SELECT id, full_name, phone_encrypted, caregiver_phone_encrypted FROM profiles WHERE id = ?')
    .get(profileId) as
    | { id: string; full_name: string; phone_encrypted: string; caregiver_phone_encrypted: string | null }
    | undefined;
  if (!row) return null;
  const caregiverEnvelope = row.caregiver_phone_encrypted;
  return {
    id: row.id,
    fullName: row.full_name,
    phone: decryptPhoneNumber(row.phone_encrypted, key),
    caregiverPhone: caregiverEnvelope ? decryptPhoneNumber(caregiverEnvelope, key) : null,
  };
}

/** ••••100001 — display-safe mask; the console never prints a raw number. */
export function maskPhoneNumber(plain: string): string {
  const tail = plain.slice(-6);
  return tail.length < plain.length ? `••••${tail}` : '••••••';
}

/**
 * Read the outbox for the demo console, newest first. Envelopes are decrypted
 * and masked here — the component layer never handles keys. An undecryptable
 * envelope masks as null so the UI can say "(unreadable)" instead of failing.
 */
export function listOutboxForConsole(db: SqliteDb, key: Buffer, limit = 100): SmsOutboxRecord[] {
  const rows = db
    .prepare(
      `SELECT id, direction, recipient_encrypted, sender, body, media_url,
              provider_message_id, delivery_mode, related_daily_schedule_id, created_at
       FROM sms_outbox
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as OutboxRow[];

  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    maskedNumber: decryptForDisplay(row.direction === 'outbound' ? row.recipient_encrypted : row.sender, key),
    body: row.body,
    mediaUrl: row.media_url,
    providerMessageId: row.provider_message_id,
    deliveryMode: row.delivery_mode,
    relatedDailyScheduleId: row.related_daily_schedule_id,
    createdAt: row.created_at,
  }));
}

function decryptForDisplay(envelope: string | null, key: Buffer): string | null {
  if (!envelope) return null;
  try {
    return maskPhoneNumber(decryptPhoneNumber(envelope, key));
  } catch {
    return null;
  }
}

/** Re-export so call sites encrypt with one import (never store raw numbers). */
export { encryptPhoneNumber };
