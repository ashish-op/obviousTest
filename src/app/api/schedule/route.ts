import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { listScheduleDoses } from '@/lib/schedules/repository';
import { getScheduleSettings } from '@/lib/schedules/settings';

export const runtime = 'nodejs';

/** GET /api/schedule — the demo profile's dose rows plus the day's anchors. */
export async function GET() {
  const db = getDb();
  return NextResponse.json(
    {
      settings: getScheduleSettings(db, DEMO_PROFILE_ID),
      doses: listScheduleDoses(db, DEMO_PROFILE_ID),
    },
    { status: 200 },
  );
}
