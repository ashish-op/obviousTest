import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';
import { parseHighRiskSideEffects } from '@/lib/engines/risk-matrix';
import type {
  MedicationCreateInput,
  MedicationUpdateInput,
} from './validation';

/**
 * Medication CRUD against the PRD §2 `medications` table. Every function is
 * scoped by an explicit `profileId` — this iteration always passes the seeded
 * demo profile; the auth phase swaps the caller, not this layer.
 */

export interface MedicationRecord {
  id: string;
  profileId: string;
  brandName: string | null;
  genericName: string;
  dosage: string;
  instructionsRaw: string;
  rxcui: string | null;
  bufferType: 'absorption' | 'interaction' | null;
  minBufferMinutes: number | null;
  highRiskSideEffects: string[];
  source: 'ocr' | 'manual';
  extractionConfidence: number | null;
  createdAt: string;
  updatedAt: string;
}

interface MedicationRow {
  id: string;
  profile_id: string;
  brand_name: string | null;
  generic_name: string;
  dosage: string;
  instructions_raw: string;
  rxcui: string | null;
  buffer_type: string | null;
  min_buffer_minutes: number | null;
  high_risk_side_effects: string;
  source: string;
  extraction_confidence: number | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: MedicationRow): MedicationRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    brandName: row.brand_name,
    genericName: row.generic_name,
    dosage: row.dosage,
    instructionsRaw: row.instructions_raw,
    rxcui: row.rxcui,
    bufferType: row.buffer_type === 'absorption' || row.buffer_type === 'interaction' ? row.buffer_type : null,
    minBufferMinutes: row.min_buffer_minutes,
    highRiskSideEffects: parseHighRiskSideEffects(row.high_risk_side_effects),
    source: row.source === 'ocr' ? 'ocr' : 'manual',
    extractionConfidence: row.extraction_confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMedication(
  db: SqliteDb,
  profileId: string,
  input: MedicationCreateInput,
): MedicationRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO medications
       (id, profile_id, brand_name, generic_name, dosage, instructions_raw, rxcui,
        buffer_type, min_buffer_minutes, high_risk_side_effects, source, extraction_confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    profileId,
    input.brandName,
    input.genericName,
    input.dosage,
    input.instructionsRaw,
    input.rxcui,
    input.bufferType,
    input.minBufferMinutes,
    JSON.stringify(input.highRiskSideEffects),
    input.source,
    input.extractionConfidence,
  );
  const row = db
    .prepare('SELECT * FROM medications WHERE id = ?')
    .get(id) as MedicationRow;
  return toRecord(row);
}

export function listMedications(db: SqliteDb, profileId: string): MedicationRecord[] {
  const rows = db
    .prepare('SELECT * FROM medications WHERE profile_id = ? ORDER BY created_at, id')
    .all(profileId) as MedicationRow[];
  return rows.map(toRecord);
}

export function getMedication(
  db: SqliteDb,
  profileId: string,
  id: string,
): MedicationRecord | null {
  const row = db
    .prepare('SELECT * FROM medications WHERE id = ? AND profile_id = ?')
    .get(id, profileId) as MedicationRow | undefined;
  return row ? toRecord(row) : null;
}

/** Full-replace update of the editable card fields; timestamps refresh. */
export function updateMedication(
  db: SqliteDb,
  profileId: string,
  id: string,
  input: MedicationUpdateInput,
): MedicationRecord | null {
  const existing = getMedication(db, profileId, id);
  if (!existing) return null;

  db.prepare(
    `UPDATE medications
        SET brand_name = ?, generic_name = ?, dosage = ?, instructions_raw = ?, rxcui = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND profile_id = ?`,
  ).run(
    input.brandName,
    input.genericName,
    input.dosage,
    input.instructionsRaw,
    input.rxcui,
    id,
    profileId,
  );
  return getMedication(db, profileId, id);
}

export function deleteMedication(db: SqliteDb, profileId: string, id: string): boolean {
  const result = db
    .prepare('DELETE FROM medications WHERE id = ? AND profile_id = ?')
    .run(id, profileId);
  return result.changes > 0;
}
