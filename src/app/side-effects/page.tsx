import { LcarsFrame } from '@/components/lcars/LcarsFrame';
import { SideEffectMonitor } from '@/components/monitoring/SideEffectMonitor';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { loadSideEffectTimeline } from '@/lib/monitoring/side-effect-store';

// Live monitor over the local SQLite store: never prerender, never cache.
// (Build-time prerender would also fail — no DB exists then.)
export const dynamic = 'force-dynamic';

/**
 * Side-effect monitoring console (build spec: "red-flag status surfaces in
 * the UI and feeds the PDF timeline"). Server component — reads the demo
 * profile's doses and side-effect logs through the red-flag-timeline engine,
 * the same structure the reconciliation PDF consumes.
 */
export default function SideEffectsPage() {
  const timeline = loadSideEffectTimeline(getDb(), DEMO_PROFILE_ID);

  return (
    <main className="lcars-page">
      <LcarsFrame
        topLabel="Sickbay · Side-Effect Monitor"
        bottomLabel="DIZZY check-ins, red flags, and reconciliation prompts"
        elbow="left"
      >
        <p className="lcars-page__notice">
          Administrative tracking and advocacy tool. Not a diagnostic device;
          nothing here recommends, alters, or validates a prescription. Always
          consult a licensed clinician.
        </p>
        <SideEffectMonitor timeline={timeline} />
      </LcarsFrame>
    </main>
  );
}
