import crypto from 'node:crypto';
import { isRecord } from './json';
import type { SmsGatewayAdapter } from './types';

/**
 * Real Twilio SMS gateway (build spec: outbound via the Twilio REST API using
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER). The factory
 * selects it only when all three credentials are present.
 *
 * Same file hosts the X-Twilio-Signature validator the inbound webhook uses:
 * routes map a `false` return to HTTP 403 (invalid or missing header).
 */

const TWILIO_API_BASE = 'https://api.twilio.com';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TwilioSmsAdapterOptions {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** Injectable for contract tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export class TwilioApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TwilioApiError';
    this.status = status;
  }
}

/** POST {api}/2010-04-01/Accounts/{sid}/Messages.json — form-encoded, Basic auth. */
export function createTwilioSmsAdapter(options: TwilioSmsAdapterOptions): SmsGatewayAdapter {
  const { accountSid, authToken, fromNumber } = options;
  const baseUrl = options.baseUrl ?? TWILIO_API_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  return {
    async send(to: string, body: string, mediaUrl?: string) {
      const form = new URLSearchParams();
      form.set('To', to);
      form.set('From', fromNumber);
      form.set('Body', body);
      if (mediaUrl) {
        form.set('MediaUrl', mediaUrl);
      }

      // Per-request init: the timeout signal starts when the request does —
      // hoisting it would abort a long-lived adapter's requests after timeoutMs.
      const response = await fetchImpl(
        `${baseUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        throw new TwilioApiError(
          `Twilio send failed: ${await describeTwilioError(response)}`,
          response.status,
        );
      }

      const payload: unknown = await response.json();
      const sid = extractMessageSid(payload);
      if (!sid) {
        throw new TwilioApiError(
          `Twilio 2xx response carried no message "sid": ${describeUnknown(payload)}`,
          response.status,
        );
      }
      return { messageId: sid };
    },
  };
}

function extractMessageSid(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const sid = payload.sid;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

function describeUnknown(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return 'unserializable payload';
  }
}

/**
 * Reads Twilio's error body ({ code, message, ... }) for the message; if the
 * body is unreadable the HTTP status still surfaces via the thrown error, so
 * this fallback is enrichment, not swallowing.
 */
async function describeTwilioError(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.message === 'string') {
      const code = typeof payload.code === 'number' ? `${payload.code}: ` : '';
      return `${code}${payload.message} (HTTP ${response.status})`;
    }
  } catch {
    // Body was not JSON — fall through to the status line.
  }
  return response.statusText || `HTTP ${response.status}`;
}

export interface TwilioSignatureInput {
  authToken: string;
  /** The X-Twilio-Signature header value; null/undefined = missing header. */
  signature: string | null | undefined;
  /** Full request URL the webhook was registered under (query string included). */
  url: string;
  /** Parsed POST form fields (Twilio signature covers form params only). */
  params: Record<string, string>;
}

/**
 * Twilio webhook signature check: HMAC-SHA1 over the full URL followed by the
 * POST params concatenated in alphabetical name order (name then value, no
 * separators), keyed by the auth token, base64-encoded. Byte-order sort by
 * param name matches Twilio's documented algorithm. Constant-time compare.
 */
export function validateTwilioSignature(input: TwilioSignatureInput): boolean {
  const { authToken, signature, url, params } = input;
  if (!signature) return false; // missing header → reject

  const canonical =
    url +
    Object.keys(params)
      .sort()
      .map((name) => name + params[name])
      .join('');

  const expected = crypto
    .createHmac('sha1', authToken)
    .update(canonical, 'utf8')
    .digest('base64');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signature, 'utf8');
  return (
    expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf)
  );
}
