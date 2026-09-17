import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';
import type { PartialEnv } from '@/lib/env';
import { ApiValidationError } from '@/lib/api/errors';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_IMAGES,
  type UploadBatchResult,
} from './types';

/**
 * Photo upload handler (PRD §3): persists up to 10 label photos as local
 * blobs under the configured upload directory (default `./data/uploads`,
 * gitignored). No metadata table this iteration — the client carries the
 * returned blob URLs into the extraction step; durable object storage with
 * signed URLs is the designated later phase (build spec, open question).
 */

/** Env-configurable so tests run against a per-test temp directory. */
export function uploadsDir(env: PartialEnv): string {
  return env.SICKBAY_UPLOAD_DIR ?? './data/uploads';
}

/** Extension per accepted content type; unknown types never store. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export function isAllowedImageType(contentType: string): boolean {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType);
}

/**
 * Filename sanitization for the file-serving route: stored names are
 * server-generated UUIDs, but the GET route re-checks every request anyway —
 * defense in depth against path traversal.
 */
export function isSafeStoredFilename(filename: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) && !filename.includes('..');
}

/**
 * Persist one upload batch. Files are validated (count, type, size) before
 * any byte is written; a rejected batch writes nothing. Each file gets a
 * UUID filename — the client-supplied name is metadata only.
 */
export async function handlePhotoUpload(
  db: SqliteDb,
  files: File[],
  env: PartialEnv,
): Promise<UploadBatchResult> {
  if (files.length === 0) {
    throw new ApiValidationError('No photos provided — attach at least one label photo.');
  }
  if (files.length > MAX_UPLOAD_IMAGES) {
    throw new ApiValidationError(
      `Too many photos: ${files.length} provided, limit is ${MAX_UPLOAD_IMAGES} per scan.`,
    );
  }

  for (const file of files) {
    if (!isAllowedImageType(file.type)) {
      throw new ApiValidationError(
        `Unsupported photo type "${file.type || 'unknown'}" for "${file.name}" — use PNG, JPEG, or WebP.`,
      );
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new ApiValidationError(
        `Photo "${file.name}" is ${file.size} bytes — limit is ${MAX_IMAGE_BYTES}.`,
      );
    }
  }

  const dir = uploadsDir(env);
  await fs.mkdir(dir, { recursive: true });

  // db is currently unused (no metadata rows this iteration) but stays in the
  // signature so callers keep one handler surface when the storage phase adds
  // upload bookkeeping.
  void db;

  const uploads = await Promise.all(files.map((file) => persistBlob(dir, file)));
  return { uploads };
}

async function persistBlob(dir: string, file: File): Promise<UploadBatchResult['uploads'][number]> {
  const id = randomUUID();
  const extension = EXTENSION_BY_TYPE[file.type];
  const filename = `${id}${extension}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(path.join(dir, filename), bytes);

  return {
    id,
    filename,
    originalName: file.name,
    contentType: file.type,
    byteSize: bytes.byteLength,
    url: `/api/ingest/files/${filename}`,
  };
}

export interface StoredBlob {
  bytes: Buffer;
  contentType: string;
}

const CONTENT_TYPE_BY_EXTENSION = new Map<string, string>(
  Object.entries(EXTENSION_BY_TYPE).map(([type, ext]) => [ext, type]),
);

/**
 * Read a stored blob back for the file-serving route. Returns null for
 * unknown or unsafe names (path traversal included) — the route maps that
 * to 404.
 */
export async function readStoredUpload(
  env: PartialEnv,
  filename: string,
): Promise<StoredBlob | null> {
  if (!isSafeStoredFilename(filename)) return null;
  const contentType = CONTENT_TYPE_BY_EXTENSION.get(path.extname(filename));
  if (!contentType) return null;

  const dir = path.resolve(uploadsDir(env));
  const absolute = path.join(dir, filename);
  // Contained-check: even a crafted-but-regex-passing name must resolve
  // inside the uploads directory.
  if (path.dirname(absolute) !== dir) return null;

  try {
    const bytes = await fs.readFile(absolute);
    return { bytes, contentType };
  } catch {
    return null;
  }
}
