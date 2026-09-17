import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { regenerateDaySchedule } from '@/lib/schedules/repository';
import { getScheduleSettings } from '@/lib/schedules/settings';

export const runtime = 'nodejs';

/**
 * POST /api/schedule/regenerate — sync the day's dose rows with the current
 * medication list (solver-backed; frozen doses untouched; idempotent).
 */
export async function POST() {
  const db = getDb();
  const summary = regenerateDaySchedule(db, DEMO_PROFILE_ID, new Date());
  return NextResponse.json(
    {
      ok: true,
      created: summary.created,
      removed: summary.removed,
      updated: summary.updated,
      settings: getScheduleSettings(db, DEMO_PROFILE_ID),
      doses: summary.doses,
    },
    { status: 200 },
  );
}
