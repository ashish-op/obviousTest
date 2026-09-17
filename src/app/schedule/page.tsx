import { LcarsFrame } from '@/components/lcars/LcarsFrame';
import { ScheduleView } from '@/components/schedule/ScheduleView';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID, seedDemoProfile } from '@/lib/db/seed';
import { regenerateDaySchedule } from '@/lib/schedules/repository';
import { getScheduleSettings } from '@/lib/schedules/settings';

// Live view over the local SQLite store: never prerender, never cache.
// (Build-time prerender would also fail — no DB or encryption key exists then.)
export const dynamic = 'force-dynamic';

/**
 * Daily schedule (task 6): dose rows with statuses, the "Woke up late"
 * routine shift, deferred markers, and gold bedtime warnings. The server
 * render reconciles the persisted day plan with the medication list first
 * (solver-backed and idempotent), so a newly-added medication appears
 * without a manual rebuild. Seeding the demo profile keeps the demo
 * self-contained from a fresh database.
 */
export default function SchedulePage() {
  const db = getDb();
  seedDemoProfile(db, process.env);
  const { doses } = regenerateDaySchedule(db, DEMO_PROFILE_ID, new Date());

  return (
    <main className="lcars-page">
      <LcarsFrame
        topLabel="Sickbay · Daily Schedule"
        bottomLabel="Buffer-aware day plan — wake shifts move doses forward only"
        elbow="left"
      >
        <p className="lcars-page__notice">
          Administrative tracking and advocacy tool. Not a diagnostic device;
          nothing here recommends, alters, or validates a prescription. Always
          consult a licensed clinician.
        </p>
        <ScheduleView
          initialDoses={doses}
          initialSettings={getScheduleSettings(db, DEMO_PROFILE_ID)}
        />
      </LcarsFrame>
    </main>
  );
}
