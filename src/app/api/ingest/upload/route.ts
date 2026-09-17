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
    // Real-mode extraction forwards these URLs to the vision provider, which
    // fetches them over the network — they must be absolute against the
    // origin the client used (the public demo URL), not a bare path. Fixture
    // mode ignores the URL, so the absolute form is harmless there.
    // Behind a reverse proxy (e.g. a preview tunnel) request.url keeps the
    // internal origin, so prefer an explicit public base, then standard
    // forwarding headers, then the request origin.
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0];
    const base =
      process.env.SICKBAY_PUBLIC_BASE_URL ??
      (forwardedHost
        ? `${request.headers.get('x-forwarded-proto')?.split(',')[0] ?? 'https'}://${forwardedHost}`
        : new URL(request.url).origin);
    const uploads = result.uploads.map((upload) => ({
      ...upload,
      url: new URL(upload.url, base).toString(),
    }));
    return NextResponse.json({ uploads }, { status: 201 });
  } catch (cause) {
    if (cause instanceof ApiValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }
}
