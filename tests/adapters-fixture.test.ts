import { describe, expect, it } from 'vitest';
import {
  createFixtureDelayQueueAdapter,
  createFixtureSmsAdapter,
  createFixtureVisionAdapter,
} from '@/lib/adapters/fixture';
import { OCR_CONFIDENCE_GATE } from '@/lib/adapters/types';
import { decryptPhoneNumber } from '@/lib/crypto/phone-crypto';
import { createPendingSchedule, createTestDb, TEST_KEY_HEX } from './helpers';

const KEY = () => Buffer.from(TEST_KEY_HEX, 'hex');

describe('fixture vision adapter — build spec: scores straddle the 0.70 gate', () => {
  it('rotates the canned label set in a fixed order', async () => {
    const adapter = createFixtureVisionAdapter();

    const labels = [];
    for (let i = 0; i < 4; i += 1) {
      labels.push(await adapter.extractLabel('file://bottle.png'));
    }

    expect(labels.map((l) => l.genericName)).toEqual([
      'levothyroxine',
      'calcium carbonate',
      'metformin',
      'lisinopril',
    ]);
    expect(labels.map((l) => l.confidence)).toEqual([0.94, 0.71, 0.69, 0.42]);
  });

  it('straddles OCR_CONFIDENCE_GATE — two auto-population reads, two low-confidence', async () => {
    const adapter = createFixtureVisionAdapter();

    const labels = [];
    for (let i = 0; i < 4; i += 1) {
      labels.push(await adapter.extractLabel('file://bottle.png'));
    }

    expect(labels.filter((l) => l.confidence >= OCR_CONFIDENCE_GATE)).toHaveLength(2);
    expect(labels.filter((l) => l.confidence < OCR_CONFIDENCE_GATE)).toHaveLength(2);
  });

  it('wraps after a full cycle and restarts identically — no hidden state', async () => {
    const cycled = createFixtureVisionAdapter();
    for (let i = 0; i < 4; i += 1) await cycled.extractLabel('file://bottle.png');

    const fifth = await cycled.extractLabel('file://bottle.png');
    const restarted = await createFixtureVisionAdapter().extractLabel('file://bottle.png');
    const offset = await createFixtureVisionAdapter({ startIndex: 2 }).extractLabel(
      'file://bottle.png',
    );

    expect(fifth.genericName).toBe('levothyroxine');
    expect(restarted).toEqual(fifth);
    expect(offset.genericName).toBe('metformin');
  });
});

describe('fixture SMS adapter — build spec: appends to sms_outbox', () => {
  it('writes an outbound fixture row with the recipient encrypted at rest', async () => {
    const { db } = createTestDb();
    const now = new Date('2026-09-17T18:00:00.000Z');
    const adapter = createFixtureSmsAdapter({ db, encryptionKey: KEY, now: () => now });

    const { messageId } = await adapter.send(
      '+15550100001',
      'Dose due: levothyroxine. Reply 1 to confirm.',
    );

    const row = db
      .prepare('SELECT * FROM sms_outbox WHERE provider_message_id = ?')
      .get(messageId) as Record<string, unknown> | undefined;

    if (!row) throw new Error('expected an sms_outbox row for the fixture send');
    expect(row.delivery_mode).toBe('fixture');
    expect(row.direction).toBe('outbound');
    expect(row.body).toContain('levothyroxine');
    expect(row.created_at).toBe(now.toISOString());

    const recipient = String(row.recipient_encrypted);
    expect(recipient).not.toContain('+15550100001'); // never raw at rest
    expect(decryptPhoneNumber(recipient, KEY())).toBe('+15550100001');
  });

  it('persists media_url when present and null when absent', async () => {
    const { db } = createTestDb();
    const adapter = createFixtureSmsAdapter({ db, encryptionKey: KEY });

    await adapter.send(
      '+15550100001',
      'Your reconciliation report is ready.',
      'https://example.com/report.pdf',
    );
    await adapter.send('+15550100001', 'Dose due.');

    const rows = db.prepare('SELECT media_url FROM sms_outbox').all() as {
      media_url: string | null;
    }[];
    expect(rows.map((r) => r.media_url)).toEqual(['https://example.com/report.pdf', null]);
  });
});

describe('fixture delay queue — build spec: durable escalation_jobs rows (no QStash)', () => {
  it('enqueues a pending row at the requested deliver_at', async () => {
    const { db } = createTestDb();
    const { scheduleId, profileId } = createPendingSchedule(db);
    const adapter = createFixtureDelayQueueAdapter({ db });
    const deliverAt = new Date('2026-09-17T18:45:00.000Z');

    const { id } = await adapter.enqueue({ dailyScheduleId: scheduleId, profileId }, deliverAt);

    const row = db.prepare('SELECT * FROM escalation_jobs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error('expected an escalation_jobs row for the enqueue');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.deliver_at).toBe(deliverAt.toISOString());
    expect(row.daily_schedule_id).toBe(scheduleId);
    expect(row.profile_id).toBe(profileId);
  });

  it('refuses jobs for unknown schedules — FK integrity, not silent acceptance', async () => {
    const { db } = createTestDb();
    const adapter = createFixtureDelayQueueAdapter({ db });

    await expect(
      adapter.enqueue({ dailyScheduleId: 'missing', profileId: 'missing' }, new Date()),
    ).rejects.toThrow();
  });
});
