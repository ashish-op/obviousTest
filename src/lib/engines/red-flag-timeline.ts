/**
 * Red-flag side-effect timeline (PRD §7 physician advocacy — build spec:
 * "red-flag status surfaces in the UI and feeds the PDF timeline").
 *
 * Pure view-model over dose + side-effect-log rows: attaches each dose's
 * logs, derives its check-in state (outstanding / clean / red_flag), flags
 * what the physician must reconcile, and orders entries chronologically.
 * The side-effect monitor renders this; the reconciliation PDF consumes the
 * same structure — one decision layer, two surfaces. No I/O, no clock.
 *
 * Severity-band encoding (risk-matrix): an SMS check-in's answer IS its
 * severity band — NEGATIVE_CHECK_IN_SEVERITY (1) is an explicit denial,
 * AFFIRMED_REPORT_SEVERITY (4) an affirmed report. Classification is
 * therefore band-based (severity ≥ RECONCILIATION_MIN_SEVERITY), NOT
 * high-risk-match-based: a denied check-in on a high-risk medication must
 * stay clean, and only the high-risk-match clause of assessSideEffectReport
 * would wrongly flag it.
 */

import type { AdherenceStatus } from './types';
import { RECONCILIATION_MIN_SEVERITY } from './risk-matrix';

/** One dose row plus its medication's risk data, as the timeline sees it. */
export interface TimelineDoseInput {
  id: string;
  medicationId: string;
  medicationName: string;
  scheduledFor: string;
  adherenceStatus: AdherenceStatus;
  /** Canonical symptom names this medication monitors (may be empty). */
  highRiskSideEffects: string[];
}

/** One side_effect_logs row attributed to a dose. */
export interface TimelineLogInput {
  id: string;
  dailyScheduleId: string;
  symptom: string;
  severity: number;
  reportedAt: string;
}

export type CheckInState =
  | 'outstanding' // check-in asked at confirmation, no answer yet
  | 'clean' // answered — denied (or reported below the flag band)
  | 'red_flag'; // at least one report at or above the reconciliation band

/** A log entry with its physician-facing classification. */
export interface TimelineLogEntry {
  id: string;
  symptom: string;
  severity: number;
  reportedAt: string;
  /** Severity ≥ 3 — appears in the physician PDF with a reconciliation prompt. */
  isRedFlag: boolean;
  /** Non-empty exactly when isRedFlag — the advocacy-report prompt text. */
  reconciliationPrompt: string;
}

export interface SideEffectTimelineEntry {
  scheduleId: string;
  medicationName: string;
  scheduledFor: string;
  adherenceStatus: AdherenceStatus;
  /**
   * null — the medication monitors nothing, so no check-in is owed;
   * otherwise the dose's check-in state (see CheckInState).
   */
  checkInState: CheckInState | null;
  logs: TimelineLogEntry[];
  isRedFlag: boolean;
}

export interface SideEffectTimeline {
  /** Chronological by scheduled time (id tie-break) — render order. */
  entries: SideEffectTimelineEntry[];
  redFlagCount: number;
  hasRedFlags: boolean;
}

/** The physician advocacy prompt for one red-flagged report. */
export function reconciliationPrompt(symptom: string, medicationName: string, severity: number): string {
  return `Assess ${symptom} with ${medicationName} — reported severity ${severity}/5. Consider medication reconciliation.`;
}

/**
 * Build the timeline. Logs attach to doses by `dailyScheduleId`; every dose
 * appears (the PDF timeline is the full day), with check-in state only for
 * medications that owe a check-in.
 */
export function buildSideEffectTimeline(
  doses: readonly TimelineDoseInput[],
  logs: readonly TimelineLogInput[],
): SideEffectTimeline {
  const logsBySchedule = new Map<string, TimelineLogInput[]>();
  for (const log of logs) {
    const bucket = logsBySchedule.get(log.dailyScheduleId);
    if (bucket) bucket.push(log);
    else logsBySchedule.set(log.dailyScheduleId, [log]);
  }

  const entries: SideEffectTimelineEntry[] = [...doses]
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.id.localeCompare(b.id))
    .map((dose) => {
      const logEntries: TimelineLogEntry[] = (logsBySchedule.get(dose.id) ?? []).map((log) => ({
        id: log.id,
        symptom: log.symptom,
        severity: log.severity,
        reportedAt: log.reportedAt,
        isRedFlag: log.severity >= RECONCILIATION_MIN_SEVERITY,
        reconciliationPrompt:
          log.severity >= RECONCILIATION_MIN_SEVERITY
            ? reconciliationPrompt(log.symptom, dose.medicationName, log.severity)
            : '',
      }));

      const isRedFlag = logEntries.some((log) => log.isRedFlag);
      const owesCheckIn = dose.highRiskSideEffects.length > 0;
      const checkInState: CheckInState | null = owesCheckIn
        ? isRedFlag
          ? 'red_flag'
          : logEntries.length > 0
            ? 'clean'
            : 'outstanding'
        : null;

      return {
        scheduleId: dose.id,
        medicationName: dose.medicationName,
        scheduledFor: dose.scheduledFor,
        adherenceStatus: dose.adherenceStatus,
        checkInState,
        logs: logEntries,
        isRedFlag,
      };
    });

  const redFlagCount = entries.reduce(
    (count, entry) => count + entry.logs.filter((log) => log.isRedFlag).length,
    0,
  );
  return { entries, redFlagCount, hasRedFlags: redFlagCount > 0 };
}
