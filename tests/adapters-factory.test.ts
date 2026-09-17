import { describe, expect, it } from 'vitest';
import { getAdapters } from '@/lib/adapters';
import { createPendingSchedule, createTestDb, jsonResponse, stubJsonFetch, TEST_KEY_HEX } from './helpers';
import outputTextBody from './fixtures/concentrateai/extract-label-success-output-text.json';
import successBody from './fixtures/twilio/send-message-success.json';

const REAL_TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'ACtest00000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'unit-test-token',
  TWILIO_FROM_NUMBER: '+15550001111',
};

describe('getAdapters — factory gating on env credentials alone', () => {
  it('resolves every adapter to a fixture with ZERO network when no credentials exist', async () => {
    const { db } = createTestDb();
    const probes: string[] = [];
    const originalFetch = globalThis.fetch;
    // Tripwire: any network attempt fails loudly instead of silently passing.
    globalThis.fetch = (input) => {
      probes.push(String(input));
      return Promise.reject(new Error('Network attempted in fixture mode'));
    };

    try {
      const adapters = getAdapters({ PHONE_ENCRYPTION_KEY: TEST_KEY_HEX }, { db });

      const label = await adapters.visionOcr.extractLabel('file://bottle.png');
      expect(label.confidence).toBeGreaterThanOrEqual(0);
      expect(label.confidence).toBeLessThanOrEqual(1);

      const { messageId } = await adapters.smsGateway.send('+15550000000', 'fixture body');
      expect(messageId.startsWith('fixture_')).toBe(true);

      const { scheduleId, profileId } = createPendingSchedule(db);
      const job = await adapters.delayQueue.enqueue(
        { dailyScheduleId: scheduleId, profileId },
        new Date(),
      );
      expect(job.id).toBeTruthy();

      const outbox = db.prepare('SELECT delivery_mode FROM sms_outbox').all() as {
        delivery_mode: string;
      }[];
      expect(outbox).toHaveLength(1);
      expect(outbox[0].delivery_mode).toBe('fixture');

      expect(probes).toEqual([]); // the zero-network proof
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('switches SMS to real Twilio when all three credentials exist — one recorded call, nothing else', async () => {
    const { db } = createTestDb();
    const { impl, calls } = stubJsonFetch(jsonResponse(successBody, 201));
    const adapters = getAdapters(REAL_TWILIO_ENV, { db, fetchImpl: impl });

    const { messageId } = await adapters.smsGateway.send('+15550100001', 'hello');

    expect(messageId).toBe(successBody.sid);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toContain('api.twilio.com');
  });

  it('keeps integrations independent — real Twilio credentials do not force OCR real', async () => {
    const { db } = createTestDb();
    const { impl, calls } = stubJsonFetch(jsonResponse(successBody, 201));
    const adapters = getAdapters(REAL_TWILIO_ENV, { db, fetchImpl: impl });

    const label = await adapters.visionOcr.extractLabel('file://bottle.png');
    expect(label.genericName).toBe('levothyroxine'); // canned fixture, not a model reply
    expect(calls).toHaveLength(0); // fixture OCR never dialed out

    await adapters.smsGateway.send('+15550100001', 'x');
    expect(calls).toHaveLength(1); // SMS is the real adapter
  });

  it('switches OCR to real ConcentrateAI on the key, honoring env base URL and model', async () => {
    const { db } = createTestDb();
    const { impl, calls } = stubJsonFetch(jsonResponse(outputTextBody, 200));
    const adapters = getAdapters(
      {
        CONCENTRATEAI_API_KEY: 'sk-unit-test',
        CONCENTRATEAI_BASE_URL: 'https://gateway.internal/v1',
        CONCENTRATEAI_VISION_MODEL: 'llava-label',
      },
      { db, fetchImpl: impl },
    );

    const label = await adapters.visionOcr.extractLabel('file://bottle.png');

    expect(label.genericName).toBe('levothyroxine');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('https://gateway.internal/v1/responses');
    const sent = JSON.parse(String(calls[0].init?.body)) as { model: string };
    expect(sent.model).toBe('llava-label');
  });

  it('gates on the full Twilio credential triple — a partial pair stays fixture', async () => {
    const { db } = createTestDb();
    const { impl, calls } = stubJsonFetch(jsonResponse(successBody, 201));
    const adapters = getAdapters(
      { ...REAL_TWILIO_ENV, TWILIO_AUTH_TOKEN: undefined, PHONE_ENCRYPTION_KEY: TEST_KEY_HEX },
      { db, fetchImpl: impl },
    );

    const { messageId } = await adapters.smsGateway.send('+15550000000', 'x');

    expect(messageId.startsWith('fixture_')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('reads ONLY the env passed in — leaked process.env credentials do not flip the gate', async () => {
    const { db } = createTestDb();
    process.env.TWILIO_ACCOUNT_SID = 'ACleak';
    process.env.CONCENTRATEAI_API_KEY = 'sk-leak';

    try {
      const adapters = getAdapters({ PHONE_ENCRYPTION_KEY: TEST_KEY_HEX }, { db });

      const { messageId } = await adapters.smsGateway.send('+15550000000', 'x');
      expect(messageId.startsWith('fixture_')).toBe(true);

      const label = await adapters.visionOcr.extractLabel('file://bottle.png');
      expect([0.94, 0.71, 0.69, 0.42]).toContain(label.confidence);
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.CONCENTRATEAI_API_KEY;
    }
  });
});
