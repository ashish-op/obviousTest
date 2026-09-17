import { LcarsFrame } from '@/components/lcars/LcarsFrame';
import { BatchScanner } from '@/components/ingestion/BatchScanner';

export default function ScannerPage() {
  return (
    <main className="lcars-page">
      <LcarsFrame
        topLabel="Sickbay · Label Intake"
        bottomLabel="Photo batch scanner — confidence-gated ingestion"
        elbow="left"
      >
        <p className="lcars-page__notice">
          Administrative tracking and advocacy tool. Not a diagnostic device;
          nothing here recommends, alters, or validates a prescription. Always
          consult a licensed clinician.
        </p>
        <BatchScanner />
      </LcarsFrame>
    </main>
  );
}
