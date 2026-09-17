import { DataValue } from '@/components/lcars/DataValue';
import { DemoControls } from '@/components/lcars/DemoControls';
import { LcarsFrame } from '@/components/lcars/LcarsFrame';
import { LcarsPanel } from '@/components/lcars/LcarsPanel';
import { StatusPill } from '@/components/lcars/StatusPill';

export default function Home() {
  return (
    <main className="lcars-page">
      <LcarsFrame
        topLabel="Sickbay · Medication Companion"
        bottomLabel="LCARS design system — task 2 demo surface"
        elbow="left"
      >
        <p className="lcars-page__notice">
          Administrative tracking and advocacy tool. Not a diagnostic device;
          nothing here recommends, alters, or validates a prescription. Always
          consult a licensed clinician.
        </p>
        <DemoControls />
        <div className="lcars-grid">
          <LcarsPanel label="Morning doses" tone="panel">
            <DataValue label="Levothyroxine" value="07:00" unit="50 mcg" />
            <StatusPill status="pending">pending</StatusPill>
          </LcarsPanel>
          <LcarsPanel label="Buffer watch" tone="gold">
            <DataValue label="Calcium gap" value="2.0" unit="hours" />
            <StatusPill status="alert">buffer conflict</StatusPill>
          </LcarsPanel>
          <LcarsPanel label="Adherence" tone="ice">
            <DataValue label="Confirmed today" value={3} unit="of 8" />
            <StatusPill status="confirmed">on track</StatusPill>
          </LcarsPanel>
        </div>
      </LcarsFrame>
    </main>
  );
}
