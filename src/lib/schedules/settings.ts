/**
 * Schedule settings — the wake/bedtime anchors the current daily plan was
 * built from (schedule_settings table, migration 0002). "Woke up late"
 * shift deltas are computed against the stored wake; bedtime is the gold
 * warning boundary. Missing row = demo defaults; a malformed row is an
 * integrity failure and surfaces as a thrown error.
 */

import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';
import { isHhMmClock } from './clock';

/** The day's anchors (HH:MM wall clock, UTC in this build). */
export interface ScheduleSettings {
  wakeTime: string;
  bedtime: string;
}

/** Demo defaults — PRD §4 worked case anchors. */
export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  wakeTime: '07:00',
  bedtime: '22:00',
};

interface SettingsRow {
  wake_time: string;
  bedtime: string;
}

export function getScheduleSettings(db: SqliteDb, profileId: string): ScheduleSettings {
  const row = db
    .prepare('SELECT wake_time, bedtime FROM schedule_settings WHERE profile_id = ?')
    .get(profileId) as SettingsRow | undefined;
  if (!row) return { ...DEFAULT_SCHEDULE_SETTINGS };
  return toSettings(row.wake_time, row.bedtime);
}

/** Insert the defaults row if absent (one row per profile), then read it. */
export function ensureScheduleSettings(db: SqliteDb, profileId: string): ScheduleSettings {
  db.prepare('INSERT OR IGNORE INTO schedule_settings (id, profile_id) VALUES (?, ?)').run(
    randomUUID(),
    profileId,
  );
  return getScheduleSettings(db, profileId);
}

/** Persist both anchors; throws RangeError on a non-HH:MM value. */
export function updateScheduleSettings(
  db: SqliteDb,
  profileId: string,
  settings: ScheduleSettings,
): void {
  assertClock(settings.wakeTime, 'wakeTime');
  assertClock(settings.bedtime, 'bedtime');
  ensureScheduleSettings(db, profileId);
  db.prepare(
    `UPDATE schedule_settings
        SET wake_time = ?, bedtime = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE profile_id = ?`,
  ).run(settings.wakeTime, settings.bedtime, profileId);
}

function toSettings(wakeTime: string, bedtime: string): ScheduleSettings {
  assertClock(wakeTime, 'wakeTime');
  assertClock(bedtime, 'bedtime');
  return { wakeTime, bedtime };
}

function assertClock(value: string, field: string): void {
  if (!isHhMmClock(value)) {
    throw new RangeError(`schedule_settings.${field} must be HH:MM, got "${value}"`);
  }
}
