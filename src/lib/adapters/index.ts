import type { SqliteDb } from '@/lib/db/connection';
import { loadEncryptionKey } from '@/lib/crypto/phone-crypto';
import {
  createFixtureDelayQueueAdapter,
  createFixtureSmsAdapter,
  createFixtureVisionAdapter,
} from './fixture';
import { createConcentrateAiVisionAdapter } from './concentrateai';
import { createTwilioSmsAdapter } from './twilio';
import type { Adapters, Env } from './types';

export * from './types';

export interface AdapterDeps {
  /** Migrated database the fixture adapters write to (outbox + queue rows). */
  db: SqliteDb;
  /** Injectable fetch for recorded-fixture contract tests; defaults to global. */
  fetchImpl?: typeof fetch;
}

/**
 * Real-mode gate for the SMS integration: all three Twilio credentials present.
 * The inbound webhook's signature check shares this gate so authorization and
 * adapter selection can never disagree about what "real mode" is.
 */
export function hasTwilioCredentials(env: Env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
}

function isRealTwilio(env: Env): [string, string, string] | null {
  if (!hasTwilioCredentials(env)) return null;
  return [env.TWILIO_ACCOUNT_SID as string, env.TWILIO_AUTH_TOKEN as string, env.TWILIO_FROM_NUMBER as string];
}

function concentrateAiApiKey(env: Env): string | null {
  return env.CONCENTRATEAI_API_KEY ?? null;
}

/**
 * Adapter factory (build spec "System shape"): credentials present → real
 * service adapters; absent → deterministic fixtures. The gate reads ONLY the
 * env passed in — never process.env directly — so CI, which carries no
 * credentials, always resolves fixtures and can never reach Twilio or
 * ConcentrateAI. Adapters are independent: one real credential pair does not
 * force the third integration into real mode.
 */
export function getAdapters(env: Env, deps: AdapterDeps): Adapters {
  const twilio = isRealTwilio(env);
  const smsGateway = twilio
    ? createTwilioSmsAdapter({
        accountSid: twilio[0],
        authToken: twilio[1],
        fromNumber: twilio[2],
        fetchImpl: deps.fetchImpl,
      })
    : createFixtureSmsAdapter({
        db: deps.db,
        // Lazy so real mode never demands PHONE_ENCRYPTION_KEY.
        encryptionKey: () => loadEncryptionKey(env),
      });

  const concentrateKey = concentrateAiApiKey(env);
  const visionOcr = concentrateKey
    ? createConcentrateAiVisionAdapter({
        apiKey: concentrateKey,
        baseUrl: env.CONCENTRATEAI_BASE_URL,
        model: env.CONCENTRATEAI_VISION_MODEL,
        fetchImpl: deps.fetchImpl,
      })
    : createFixtureVisionAdapter();

  const delayQueue = createFixtureDelayQueueAdapter({ db: deps.db });

  return { visionOcr, smsGateway, delayQueue };
}
