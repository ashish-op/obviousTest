/**
 * Persistence bridge for the reconciliation PDF (PRD §2 rows → PDF §7 input).
 *
 * Loads the demo profile's medications and side-effect timeline and assembles
 * the report view model. Profile-scoped like the medications repository:
 * this iteration always passes the seeded demo profile; the auth phase swaps
 * the caller, not this layer.
 */

import type { SqliteDb } from '@/lib/db/connection';
import { loadSideEffectTimeline } from '@/lib/monitoring/side-effect-store';
import {
  buildReconciliationPdfData,
  type MedicationRowView,
  type ReconciliationPdfData,
} from './data';

interface MedicationPdfRow {
  id: string;
  generic_name: string;
  dosage: string;
  instructions_raw: string;
  rxcui: string | null;
}

export function loadReconciliationPdfData(
  db: SqliteDb,
  profileId: string,
  generatedAt: string,
): ReconciliationPdfData {
  const profile = db.prepare('SELECT full_name FROM profiles WHERE id = ?').get(profileId) as
    | { full_name: string }
    | undefined;
  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }

  const medicationRows = db
    .prepare(
      'SELECT id, generic_name, dosage, instructions_raw, rxcui FROM medications WHERE profile_id = ? ORDER BY created_at, id',
    )
    .all(profileId) as MedicationPdfRow[];

  const medications: MedicationRowView[] = medicationRows.map((row) => ({
    id: row.id,
    genericName: row.generic_name,
    dosage: row.dosage,
    instructionsRaw: row.instructions_raw,
    rxcui: row.rxcui,
  }));

  return buildReconciliationPdfData({
    patientName: profile.full_name,
    generatedAt,
    medications,
    timeline: loadSideEffectTimeline(db, profileId),
  });
}
