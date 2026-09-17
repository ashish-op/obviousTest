import { LcarsFrame } from '@/components/lcars/LcarsFrame';
import { OutboxTable } from '@/components/outbox/OutboxTable';
import { SweepControls } from '@/components/outbox/SweepControls';
import { loadEncryptionKey } from '@/lib/crypto/phone-crypto';
import { getDb } from '@/lib/db/connection';
import { listOutboxForConsole } from '@/lib/telephony/outbox';

// Live console over the local SQLite store: never prerender, never cache.
// (Build-time prerender would also fail — no DB or encryption key exists then.)
export const dynamic = 'force-dynamic';

/**
 * SMS outbox console (build spec: sms_outbox holds every outbound message in
 * both modes "so the demo console renders what would hit a phone"). Server
 * component — reads the outbox, masks numbers, hands plain records to the
 * presentational table.
 */
export default function OutboxPage() {
  const db = getDb();
  const records = listOutboxForConsole(db, loadEncryptionKey(process.env), 100);

  return (
    <main className="lcars-page">
      <LcarsFrame
        topLabel="Sickbay · SMS Outbox Console"
        bottomLabel="Every transmission, fixture and real — numbers masked"
        elbow="left"
      >
        <p className="lcars-page__notice">
          Administrative tracking and advocacy tool. Not a diagnostic device;
          nothing here recommends, alters, or validates a prescription. Always
          consult a licensed clinician.
        </p>
        <SweepControls />
        <OutboxTable records={records} />
      </LcarsFrame>
    </main>
  );
}
