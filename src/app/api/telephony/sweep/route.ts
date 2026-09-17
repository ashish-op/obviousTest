import { NextResponse } from 'next/server';
import { getAdapters } from '@/lib/adapters';
import { loadEncryptionKey } from '@/lib/crypto/phone-crypto';
import { getDb } from '@/lib/db/connection';
import { runEscalationSweep } from '@/lib/telephony/sweep';

/**
 * One escalation sweep tick (build spec: in-process sweep over durable
 * escalation_jobs rows; a production job runner swaps in behind this endpoint
 * later). The demo console's sweep button POSTs here; a cron/worker can hit
 * the same route on an interval without any code change.
 */
export async function POST() {
  const db = getDb();
  const adapters = getAdapters(process.env, { db });
  const outcome = await runEscalationSweep(
    db,
    adapters,
    loadEncryptionKey(process.env),
    new Date(), // the real clock lives only here at the edge
  );
  return NextResponse.json({ ok: true, outcome }, { status: 200 });
}
