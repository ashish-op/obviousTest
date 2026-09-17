import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/connection';
import { ApiValidationError } from '@/lib/api/errors';
import { handlePhotoUpload } from '@/lib/ingestion/upload';

export const runtime = 'nodejs';

/**
 * POST /api/ingest/upload — multipart form, field "photos", 1–10 images
 * (PRD §3). Blobs land in local storage; the response carries the fetchable
 * URLs the extraction step consumes.
 */
export async function POST(request: NextRequest) {
  let files: File[];
  try {
    const form = await request.formData();
    files = form.getAll('photos').filter((entry): entry is File => entry instanceof File);
  } catch {
    return NextResponse.json(
      { error: 'Expected a multipart form with a "photos" field.' },
      { status: 400 },
    );
  }

  try {
    const result = await handlePhotoUpload(getDb(), files, process.env);
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    if (cause instanceof ApiValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }
}
