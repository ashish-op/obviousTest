import { NextRequest, NextResponse } from 'next/server';
import { ApiValidationError } from '@/lib/api/errors';
import { applyShift } from '@/lib/schedules/repository';
import { parseShiftInput } from '@/lib/schedules/validation';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';

export const runtime = 'nodejs';

/**
 * POST /api/schedule/shift — "Woke up late". Body: {"wakeTime": "HH:MM"}.
 * Shifts every unresolved dose by the clamped wake delta, re-enforces
 * buffers forward-only, recomputes bedtime warnings, persists the new wake
 * anchor, and returns the fresh dose list.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  try {
    const input = parseShiftInput(body);
    const summary = applyShift(getDb(), DEMO_PROFILE_ID, input.wakeTime, new Date());
    return NextResponse.json(
      {
        ok: true,
        wakeDeltaMinutes: summary.wakeDeltaMinutes,
        hasBedtimeWarnings: summary.hasBedtimeWarnings,
        doses: summary.doses,
      },
      { status: 200 },
    );
  } catch (cause) {
    if (cause instanceof ApiValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }
}
