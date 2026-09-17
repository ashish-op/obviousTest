import crypto from 'node:crypto';
import type { PartialEnv } from '../env';

/**
 * AES-256-GCM encryption for phone numbers at rest (PRD §8).
 *
 * Envelope format: `v1:<iv>:<tag>:<ciphertext>`, all base64url — the version
 * prefix leaves room for future key rotation without a migration.
 */

const ENVELOPE_VERSION = 'v1';
const ENVELOPE_PARTS = 4;
const KEY_BYTES = 32;

// PartialEnv, not NodeJS.ProcessEnv: Next.js types NODE_ENV as required on
// the global ProcessEnv, and tests pass env objects without it. Node's own
// typing treats every var as optional.
export function loadEncryptionKey(env: PartialEnv = process.env): Buffer {
  const raw = env.PHONE_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(
      'PHONE_ENCRYPTION_KEY is required (generate with `openssl rand -hex 32` — see .env.example)',
    );
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `PHONE_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}) — use \`openssl rand -hex 32\` or 32-byte base64`,
    );
  }

  return key;
}

export function encryptPhoneNumber(plain: string, key: Buffer): string {
  if (!plain) {
    throw new Error('encryptPhoneNumber requires a non-empty phone number');
  }

  // 12-byte IV per NIST SP 800-38D for GCM; random per message so identical
  // phone numbers never produce identical envelopes.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptPhoneNumber(envelope: string, key: Buffer): string {
  const parts = envelope.split(':');
  if (parts.length !== ENVELOPE_PARTS || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Unrecognized phone envelope format (expected v1:<iv>:<tag>:<ciphertext>)');
  }

  const [, iv, authTag, ciphertext] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64url'));

  // Throws on tampering or wrong key (GCM auth-tag mismatch) — by design.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
