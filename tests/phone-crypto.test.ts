import { describe, expect, it } from 'vitest';
import {
  decryptPhoneNumber,
  encryptPhoneNumber,
  loadEncryptionKey,
} from '@/lib/crypto/phone-crypto';
import { TEST_KEY_HEX } from './helpers';

const KEY = Buffer.from(TEST_KEY_HEX, 'hex');
const PHONE = '+15551230000';

describe('phone-crypto — AES-256-GCM round trip (PRD §8)', () => {
  it('round-trips an E.164 phone number through encrypt/decrypt', () => {
    const envelope = encryptPhoneNumber(PHONE, KEY);
    expect(decryptPhoneNumber(envelope, KEY)).toBe(PHONE);
  });

  it('emits a versioned four-part envelope', () => {
    const parts = encryptPhoneNumber(PHONE, KEY).split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('never repeats ciphertext for the same plaintext (random IV)', () => {
    const a = encryptPhoneNumber(PHONE, KEY);
    const b = encryptPhoneNumber(PHONE, KEY);
    expect(a).not.toBe(b);
    // Both still decrypt to the same number.
    expect(decryptPhoneNumber(a, KEY)).toBe(PHONE);
    expect(decryptPhoneNumber(b, KEY)).toBe(PHONE);
  });

  it('never exposes the plaintext in the envelope', () => {
    expect(encryptPhoneNumber(PHONE, KEY)).not.toContain(PHONE);
  });

  it('rejects empty plaintext', () => {
    expect(() => encryptPhoneNumber('', KEY)).toThrow(/non-empty/);
  });

  it('detects tampered ciphertext (GCM auth tag mismatch)', () => {
    const envelope = encryptPhoneNumber(PHONE, KEY);
    const [v, iv, tag, ct] = envelope.split(':');
    const flippedCt = ct.slice(0, -2) + (ct.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptPhoneNumber(`${v}:${iv}:${tag}:${flippedCt}`, KEY)).toThrow();
  });

  it('detects tampered auth tag', () => {
    const envelope = encryptPhoneNumber(PHONE, KEY);
    const [v, iv, tag, ct] = envelope.split(':');
    const flippedTag = tag.slice(0, -2) + (tag.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptPhoneNumber(`${v}:${iv}:${flippedTag}:${ct}`, KEY)).toThrow();
  });

  it('refuses decryption under a different key', () => {
    const otherKey = Buffer.from('cd'.repeat(32), 'hex');
    const envelope = encryptPhoneNumber(PHONE, KEY);
    expect(() => decryptPhoneNumber(envelope, otherKey)).toThrow();
  });

  it('rejects malformed envelopes', () => {
    expect(() => decryptPhoneNumber('garbage', KEY)).toThrow(/envelope/);
    expect(() => decryptPhoneNumber('v2:a:b:c', KEY)).toThrow(/envelope/);
    expect(() => decryptPhoneNumber('a:b:c', KEY)).toThrow(/envelope/);
  });
});

describe('loadEncryptionKey — env key handling', () => {
  it('accepts a 64-char hex key', () => {
    expect(loadEncryptionKey({ PHONE_ENCRYPTION_KEY: TEST_KEY_HEX }).length).toBe(32);
  });

  it('accepts a 32-byte base64 key', () => {
    const b64 = Buffer.from('ab'.repeat(32), 'hex').toString('base64');
    expect(loadEncryptionKey({ PHONE_ENCRYPTION_KEY: b64 }).length).toBe(32);
  });

  it('throws with actionable guidance when the key is missing', () => {
    expect(() => loadEncryptionKey({})).toThrow(/PHONE_ENCRYPTION_KEY is required/);
  });

  it('throws when the key does not decode to 32 bytes', () => {
    expect(() => loadEncryptionKey({ PHONE_ENCRYPTION_KEY: 'a'.repeat(63) })).toThrow(/32 bytes/);
    expect(() => loadEncryptionKey({ PHONE_ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes/);
  });
});
