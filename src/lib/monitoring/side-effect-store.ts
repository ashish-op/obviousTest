/**
 * Side-effect timeline persistence (PRD §2 side_effect_logs + daily_schedules).
 *
 * Loads one profile's doses and side-effect logs and feeds them through the
 * pure red-flag-timeline engine — the single decision layer the side-effect
 * monitor and the reconciliation PDF both render. Profile-scoped like the
 * medications repository: this iteration always passes the seeded demo
 * profile; the auth phase swaps the caller, not this layer.
 */

import type { SqliteDb } from '@/lib/db/connection';
import { parseHighRiskSideEffects } from '@/lib/engines/risk-matrix';
import type { AdherenceStatus } from '@/lib/engines/types';
import {
  buildSideEffectTimeline,
  type SideEffectTimeline,
  type TimelineDoseInput,
  type TimelineLogInput,
} from '@/lib/engines/red-flag-timeline';

interface TimelineDoseRow {
  id: string;
  medication_id: string;
  generic_name: string;
  scheduled_for: string;
  adherence_status: string;
  high_risk_side_effects: string;
}

interface TimelineLogRow {
  id: string;
  daily_schedule_id: string | null;
  symptom: string;
  severity: number;
  reported_at: string;
}

/** The DDL CHECK constrains adherence_status to the engine enum — trust it. */
function toAdherenceStatus(raw: string): AdherenceStatus {
  if (raw === 'PENDING' || raw === 'CONFIRMED' || raw === 'ESCALATED' || raw === 'SKIPPED') {
    return raw;
  }
  throw new Error(`daily_schedules.adherence_status holds an unknown value: ${raw}`);
}

export function loadSideEffectTimeline(db: SqliteDb, profileId: string): SideEffectTimeline {
  const doseRows = db
    .prepare(
      `SELECT s.id, s.medication_id, m.generic_name, s.scheduled_for, s.adherence_status, m.high_risk_side_effects
       FROM daily_schedules s
       JOIN medications m ON m.id = s.medication_id
       WHERE s.profile_id = ?
       ORDER BY s.scheduled_for, s.id`,
    )
    .all(profileId) as TimelineDoseRow[];

  const logRows = db
    .prepare(
      `SELECT id, daily_schedule_id, symptom, severity, reported_at
       FROM side_effect_logs
       WHERE profile_id = ?
       ORDER BY reported_at, id`,
    )
    .all(profileId) as TimelineLogRow[];

  const doses: TimelineDoseInput[] = doseRows.map((row) => ({
    id: row.id,
    medicationId: row.medication_id,
    medicationName: row.generic_name,
    scheduledFor: row.scheduled_for,
    adherenceStatus: toAdherenceStatus(row.adherence_status),
    highRiskSideEffects: parseHighRiskSideEffects(row.high_risk_side_effects),
  }));

  // The handler only ever inserts attributed logs (medication_id is NOT NULL),
  // but ON DELETE SET NULL can orphan a row — an unattachable log cannot join
  // a dose timeline, so it is skipped here rather than silently re-attributed.
  const logs: TimelineLogInput[] = logRows.flatMap((row) =>
    row.daily_schedule_id === null
      ? []
      : [
          {
            id: row.id,
            dailyScheduleId: row.daily_schedule_id,
            symptom: row.symptom,
            severity: row.severity,
            reportedAt: row.reported_at,
          },
        ],
  );

  return buildSideEffectTimeline(doses, logs);
}
