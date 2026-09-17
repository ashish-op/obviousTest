// Test setup: a deterministic key for any code path that falls back to
// process.env. Tests that exercise key handling pass explicit keys/envs.
process.env.PHONE_ENCRYPTION_KEY ??= 'ab'.repeat(32);
