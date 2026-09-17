import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createTwilioSmsAdapter,
  TwilioApiError,
  validateTwilioSignature,
} from '@/lib/adapters/twilio';
import { jsonResponse, stubJsonFetch } from './helpers';
import errorBody from './fixtures/twilio/send-message-error.json';
import successBody from './fixtures/twilio/send-message-success.json';

const CREDENTIALS = {
  accountSid: 'ACtest00000000000000000000000000',
  authToken: 'unit-test-auth-token',
  fromNumber: '+15550001111',
};

/** The sid inside tests/fixtures/twilio/send-message-success.json. */
const RECORDED_SID = 'SM8f2a1c4e77b94d0aa6f5e3c2d1b0a998';

describe('createTwilioSmsAdapter — recorded-fixture contract tests (no live calls)', () => {
  it('sends a form-encoded POST with Basic auth and returns the recorded sid', async () => {
    const { impl, calls } = stubJsonFetch(jsonResponse(successBody, 201));
    const adapter = createTwilioSmsAdapter({ ...CREDENTIALS, fetchImpl: impl });

    const result = await adapter.send(
      '+15550100001',
      'Dose due: levothyroxine. Reply 1 to confirm.',
    );

    expect(result).toEqual({ messageId: RECORDED_SID });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.input).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${CREDENTIALS.accountSid}/Messages.json`,
    );
    expect(call.init?.method).toBe('POST');
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`${CREDENTIALS.accountSid}:${CREDENTIALS.authToken}`).toString('base64')}`,
    );
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const form = new URLSearchParams(String(call.init?.body));
    expect(form.get('To')).toBe('+15550100001');
    expect(form.get('From')).toBe(CREDENTIALS.fromNumber);
    expect(form.get('Body')).toContain('levothyroxine');
    expect(form.has('MediaUrl')).toBe(false);
  });

  it('includes MediaUrl in the form when provided', async () => {
    const { impl, calls } = stubJsonFetch(jsonResponse(successBody, 201));
    const adapter = createTwilioSmsAdapter({ ...CREDENTIALS, fetchImpl: impl });

    await adapter.send('+15550100001', 'Your reconciliation report.', 'https://example.com/r.pdf');

    const form = new URLSearchParams(String(calls[0].init?.body));
    expect(form.get('MediaUrl')).toBe('https://example.com/r.pdf');
  });

  it('raises TwilioApiError with the recorded error message on a 400', async () => {
    const { impl } = stubJsonFetch(jsonResponse(errorBody, 400));
    const adapter = createTwilioSmsAdapter({ ...CREDENTIALS, fetchImpl: impl });

    await expect(adapter.send('+15550100001', 'x')).rejects.toMatchObject({
      name: 'TwilioApiError',
      status: 400,
      message: expect.stringContaining("21211: The 'To' number is not a valid phone number."),
    });
  });
});

describe('validateTwilioSignature — webhook util (valid / invalid / missing)', () => {
  const authToken = CREDENTIALS.authToken;
  const url = 'https://sickbay.example/api/telephony/sms-inbound';
  const params = { From: '+15550100001', To: '+15550001111', Body: '1' };

  /** Independent HMAC construction — the canonical string is explicit, not inherited from the util. */
  function expectedSignature(canonical: string, token: string = authToken): string {
    return crypto.createHmac('sha1', token).update(canonical, 'utf8').digest('base64');
  }

  it('accepts a correctly signed request — explicit canonical-string vector', () => {
    // Canonical data written out literally: URL, then POST params alphabetically
    // (Body, From, To), each appended as name + value with no separators.
    const canonical = `${url}Body1From+15550100001To+15550001111`;

    expect(
      validateTwilioSignature({
        authToken,
        signature: expectedSignature(canonical),
        url,
        params,
      }),
    ).toBe(true);
  });

  it('accepts regardless of the params object insertion order (util sorts)', () => {
    const signature = expectedSignature(`${url}Body1From+15550100001To+15550001111`);

    expect(
      validateTwilioSignature({
        authToken,
        signature,
        url,
        params: { To: '+15550001111', Body: '1', From: '+15550100001' },
      }),
    ).toBe(true);
  });

  it('accepts a parameterless request signed over the URL alone', () => {
    expect(
      validateTwilioSignature({
        authToken,
        signature: expectedSignature(url),
        url,
        params: {},
      }),
    ).toBe(true);
  });

  it('rejects a signature produced with the wrong token', () => {
    const signature = expectedSignature(
      `${url}Body1From+15550100001To+15550001111`,
      'wrong-token',
    );

    expect(validateTwilioSignature({ authToken, signature, url, params })).toBe(false);
  });

  it('rejects a tampered param set', () => {
    const signature = expectedSignature(`${url}Body1From+15550100001To+15550001111`);

    expect(
      validateTwilioSignature({
        authToken,
        signature,
        url,
        params: { ...params, Body: 'DIZZY YES' },
      }),
    ).toBe(false);
  });

  it('rejects a forged same-length signature (exercises the constant-time compare path)', () => {
    const forged = 'A'.repeat(28); // base64 SHA-1 digests are exactly 28 chars

    expect(validateTwilioSignature({ authToken, signature: forged, url, params })).toBe(false);
  });

  it('fails closed on a missing header — undefined, null, and empty all reject (route maps to 403)', () => {
    for (const signature of [undefined, null, '']) {
      expect(validateTwilioSignature({ authToken, signature, url, params })).toBe(false);
    }
  });
});
