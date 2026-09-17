import crypto from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';
import { encryptPhoneNumber } from '@/lib/crypto/phone-crypto';
import type { SmsGatewayAdapter, SmsSendResult } from './types';

/**
 * Outbox recording for REAL-mode sends (build spec: sms_outbox holds "every
 * outbound message in both modes, so the demo console renders what would hit
 * a phone"). The fixture adapter already records its own sends; this decorator
 * wraps the real Twilio adapter in the factory so no call site can forget.
 *
 * The row is written AFTER the provider call succeeds and carries the real
 * provider message sid — a failed send never claims to have been sent.
 */
export interface OutboxRecordingSmsOptions {
  db: SqliteDb;
  /** Resolves the AES-256-GCM key lazily at send time (never raw at rest). */
  encryptionKey: () => Buffer;
  now?: () => Date;
}

export function createOutboxRecordingSmsAdapter(
  inner: SmsGatewayAdapter,
  options: OutboxRecordingSmsOptions,
): SmsGatewayAdapter {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  return {
    async send(to: string, body: string, mediaUrl?: string): Promise<SmsSendResult> {
      const result = await inner.send(to, body, mediaUrl);
      db.prepare(
        `INSERT INTO sms_outbox
           (id, direction, recipient_encrypted, body, media_url, provider_message_id, delivery_mode, created_at)
         VALUES (?, 'outbound', ?, ?, ?, ?, 'real', ?)`,
      ).run(
        crypto.randomUUID(),
        encryptPhoneNumber(to, options.encryptionKey()),
        body,
        mediaUrl ?? null,
        result.messageId,
        now().toISOString(),
      );
      return result;
    },
  };
}
