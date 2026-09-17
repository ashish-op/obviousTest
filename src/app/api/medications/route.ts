import { NextRequest, NextResponse } from 'next/server';
import { ApiValidationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { createMedication, listMedications } from '@/lib/medications/repository';
import { parseMedicationCreateInput } from '@/lib/medications/validation';

export const runtime = 'nodejs';

/** GET /api/medications — the demo profile's medication list. */
export async function GET() {
  return NextResponse.json(
    { medications: listMedications(getDb(), DEMO_PROFILE_ID) },
    { status: 200 },
  );
}

/**
 * POST /api/medications — saves a medication card, OCR-populated
 * (source='ocr' with the gate score) or hand-entered after MANUAL OVERRIDE
 * (source='manual', confidence null).
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  try {
    const input = parseMedicationCreateInput(body);
    const medication = createMedication(getDb(), DEMO_PROFILE_ID, input);
    return NextResponse.json(medication, { status: 201 });
  } catch (cause) {
    if (cause instanceof ApiValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }
}
