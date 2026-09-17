import { NextRequest, NextResponse } from 'next/server';
import { ApiValidationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { deleteMedication, getMedication, updateMedication } from '@/lib/medications/repository';
import { parseMedicationCoreFields } from '@/lib/medications/validation';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

/** GET /api/medications/[id] — one medication, scoped to the demo profile. */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const medication = getMedication(getDb(), DEMO_PROFILE_ID, params.id);
  if (!medication) {
    return NextResponse.json({ error: 'Medication not found.' }, { status: 404 });
  }
  return NextResponse.json(medication, { status: 200 });
}

/** PATCH /api/medications/[id] — full-replace of the editable card fields. */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  try {
    const input = parseMedicationCoreFields(body);
    const medication = updateMedication(getDb(), DEMO_PROFILE_ID, params.id, input);
    if (!medication) {
      return NextResponse.json({ error: 'Medication not found.' }, { status: 404 });
    }
    return NextResponse.json(medication, { status: 200 });
  } catch (cause) {
    if (cause instanceof ApiValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }
}

/** DELETE /api/medications/[id] — removes the medication (schedules cascade). */
export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const deleted = deleteMedication(getDb(), DEMO_PROFILE_ID, params.id);
  if (!deleted) {
    return NextResponse.json({ error: 'Medication not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
