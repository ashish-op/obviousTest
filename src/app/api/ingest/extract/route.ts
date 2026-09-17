import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@/lib/adapters/json';
import { ApiValidationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db/connection';
import { getAdapters } from '@/lib/adapters';
import { extractFromPhotos } from '@/lib/ingestion/extract';

export const runtime = 'nodejs';

function parseImageUrlList(body: unknown): string[] {
  if (!isRecord(body)) {
    throw new ApiValidationError('Request body must be a JSON object.');
  }
  const urls = body.imageUrls;
  if (!Array.isArray(urls) || urls.some((entry) => typeof entry !== 'string')) {
    throw new ApiValidationError('"imageUrls" must be an array of strings.');
  }
  return urls as string[];
}

/**
 * POST /api/ingest/extract — body { imageUrls: string[] }. Runs every photo
 * through the env-selected VisionOcrAdapter (credentials present → real
 * ConcentrateAI; absent → deterministic fixtures) and returns the per-image
 * confidence-gate outcome. Credential-free CI resolves fixtures and can
 * never reach a real service.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  try {
    const imageUrls = parseImageUrlList(body);
    const db = getDb();
    const result = await extractFromPhotos(
      { db, adapters: getAdapters(process.env, { db }) },
      imageUrls,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    if (cause instanceof ApiValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }
}
