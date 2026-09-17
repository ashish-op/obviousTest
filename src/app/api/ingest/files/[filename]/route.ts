import { NextRequest, NextResponse } from 'next/server';
import { readStoredUpload } from '@/lib/ingestion/upload';

export const runtime = 'nodejs';

/**
 * GET /api/ingest/files/[filename] — serves a stored upload blob back
 * (thumbnails in the scanner UI, and the URL shape a real vision adapter
 * can consume later). Unsafe names and unknown files are 404, never errors
 * that leak filesystem detail.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { filename: string } },
) {
  const blob = await readStoredUpload(process.env, params.filename);
  if (!blob) {
    return NextResponse.json({ error: 'Upload not found.' }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(blob.bytes), {
    status: 200,
    headers: {
      'Content-Type': blob.contentType,
      'Cache-Control': 'private, no-store',
    },
  });
}
