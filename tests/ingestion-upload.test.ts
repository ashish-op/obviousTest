import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handlePhotoUpload,
  isSafeStoredFilename,
  readStoredUpload,
  uploadsDir,
} from '@/lib/ingestion/upload';
import { ApiValidationError } from '@/lib/api/errors';
import { createTestDb } from './helpers';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function pngFile(name: string, type = 'image/png', bytes = PNG_BYTES): File {
  return new File([bytes], name, { type });
}

function freshUploadEnv(): { env: { SICKBAY_UPLOAD_DIR: string }; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sickbay-uploads-'));
  return { env: { SICKBAY_UPLOAD_DIR: dir }, dir };
}

describe('photo upload handler — PRD §3 ≤10 images, local blob storage', () => {
  it('stores each photo as a local blob and returns fetchable URLs', async () => {
    const db = createTestDb();
    const { env } = freshUploadEnv();

    const result = await handlePhotoUpload(
      db.db,
      [pngFile('synthroid.png'), pngFile('tums.jpg', 'image/jpeg')],
      env,
    );

    expect(result.uploads).toHaveLength(2);
    for (const upload of result.uploads) {
      expect(upload.url).toBe(`/api/ingest/files/${upload.filename}`);
      expect(upload.byteSize).toBe(PNG_BYTES.byteLength);
      const stored = await readStoredUpload(env, upload.filename);
      expect(stored).not.toBeNull();
      expect(stored?.contentType).toBe(upload.contentType);
      expect(stored?.bytes.equals(PNG_BYTES)).toBe(true);
    }
    // Storage keys off the validated content type, not the original name.
    expect(result.uploads[0].filename.endsWith('.png')).toBe(true);
    expect(result.uploads[1].filename.endsWith('.jpg')).toBe(true);
  });

  it('rejects an 11-photo batch (limit is 10)', async () => {
    const db = createTestDb();
    const { env } = freshUploadEnv();
    const files = Array.from({ length: 11 }, (_, i) => pngFile(`photo-${i}.png`));

    await expect(handlePhotoUpload(db.db, files, env)).rejects.toThrow(ApiValidationError);
    await expect(handlePhotoUpload(db.db, files, env)).rejects.toThrow('limit is 10');
  });

  it('rejects an empty batch', async () => {
    const db = createTestDb();
    const { env } = freshUploadEnv();
    await expect(handlePhotoUpload(db.db, [], env)).rejects.toThrow('No photos provided');
  });

  it('rejects disallowed content types — a PDF is not a label photo', async () => {
    const db = createTestDb();
    const { env } = freshUploadEnv();
    const pdf = new File([PNG_BYTES], 'label.pdf', { type: 'application/pdf' });
    await expect(handlePhotoUpload(db.db, [pdf], env)).rejects.toThrow('Unsupported photo type');
  });

  it('rejects a photo over the 10 MiB cap', async () => {
    const db = createTestDb();
    const { env } = freshUploadEnv();
    const oversized = new File([Buffer.alloc(10 * 1024 * 1024 + 1)], 'huge.png', {
      type: 'image/png',
    });
    await expect(handlePhotoUpload(db.db, [oversized], env)).rejects.toThrow('limit is 10485760');
  });

  it('refuses unsafe and unknown filenames when reading blobs back', async () => {
    const db = createTestDb();
    const { env } = freshUploadEnv();
    const [upload] = (await handlePhotoUpload(db.db, [pngFile('ok.png')], env)).uploads;

    // Path traversal and garbage names never resolve — 404 surface, not a leak.
    expect(await readStoredUpload(env, '../.env')).toBeNull();
    expect(await readStoredUpload(env, 'not-a-real-blob.png')).toBeNull();
    expect(await readStoredUpload(env, upload.filename)).not.toBeNull();

    expect(isSafeStoredFilename('1266cd36-8f5c-4f6e-9f3e-2f3d2f6f4b7a.png')).toBe(true);
    expect(isSafeStoredFilename('../../etc/passwd')).toBe(false);
  });

  it('uploads dir is env-configurable', () => {
    expect(uploadsDir({})).toBe('./data/uploads');
    expect(uploadsDir({ SICKBAY_UPLOAD_DIR: '/tmp/x' })).toBe('/tmp/x');
  });
});
