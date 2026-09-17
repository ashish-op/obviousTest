/**
 * Red-flag timeline engine unit tests (build spec: "red-flag status surfaces
 * in the UI and feeds the PDF timeline" — this is the classification the
 * monitor renders and the task-9 PDF will compose).
 *
 * The severity-band encoding is the contract under test: an SMS check-in's
 * answer IS its severity band (1 = denied, ≥ 3 flagged for reconciliation),
 * so a denied check-in on a HIGH-RISK medication must stay clean — the
 * high-risk-match clause of assessSideEffectReport must not leak in.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSideEffectTimeline,
  reconciliationPrompt,
  type TimelineDoseInput,
  type TimelineLogInput,
} from '@/lib/engines/red-flag-timeline';
import { RECONCILIATION_MIN_SEVERITY } from '@/lib/engines/risk-matrix';

function dose(overrides: Partial<TimelineDoseInput> = {}): TimelineDoseInput {
  return {
    id: 'dose-1',
    medicationId: 'med-1',
    medicationName: 'Levothyroxine',
    scheduledFor: '2026-09-17T08:00:00.000Z',
    adherenceStatus: 'CONFIRMED',
    highRiskSideEffects: ['dizziness'],
    ...overrides,
  };
}

function log(overrides: Partial<TimelineLogInput> = {}): TimelineLogInput {
  return {
    id: 'log-1',
    dailyScheduleId: 'dose-1',
    symptom: 'dizziness',
    severity: 4,
    reportedAt: '2026-09-17T08:10:00.000Z',
    ...overrides,
  };
}

describe('buildSideEffectTimeline', () => {
  it('orders entries chronologically by scheduled time, id as tie-break', () => {
    const timeline = buildSideEffectTimeline(
      [
        dose({ id: 'b', scheduledFor: '2026-09-17T12:00:00.000Z' }),
        dose({ id: 'a2', scheduledFor: '2026-09-17T08:00:00.000Z' }),
        dose({ id: 'a1', scheduledFor: '2026-09-17T08:00:00.000Z' }),
      ],
      [],
    );

    expect(timeline.entries.map((entry) => entry.scheduleId)).toEqual(['a1', 'a2', 'b']);
  });

  it('marks a confirmed high-risk dose with no answer as an outstanding check-in', () => {
    const timeline = buildSideEffectTimeline([dose()], []);

    expect(timeline.entries[0].checkInState).toBe('outstanding');
    expect(timeline.entries[0].isRedFlag).toBe(false);
    expect(timeline.hasRedFlags).toBe(false);
  });

  it('keeps a denied check-in clean even on a high-risk medication (band encoding)', () => {
    const timeline = buildSideEffectTimeline([dose()], [
      log({ severity: 1, reportedAt: '2026-09-17T08:15:00.000Z' }),
    ]);

    expect(timeline.entries[0].checkInState).toBe('clean');
    expect(timeline.entries[0].isRedFlag).toBe(false);
    expect(timeline.redFlagCount).toBe(0);
  });

  it('flags an affirmed report at or above the reconciliation band with a prompt', () => {
    const timeline = buildSideEffectTimeline([dose()], [log({ severity: 4 })]);

    const entry = timeline.entries[0];
    expect(entry.checkInState).toBe('red_flag');
    expect(entry.isRedFlag).toBe(true);
    expect(timeline.hasRedFlags).toBe(true);
    expect(timeline.redFlagCount).toBe(1);
    expect(entry.logs[0].reconciliationPrompt).toBe(
      reconciliationPrompt('dizziness', 'Levothyroxine', 4),
    );
    expect(entry.logs[0].reconciliationPrompt).toContain('dizziness');
    expect(entry.logs[0].reconciliationPrompt).toContain('Levothyroxine');
  });

  it('flags by severity band alone — a severity-3 report on a non-monitoring med still flags', () => {
    const timeline = buildSideEffectTimeline(
      [dose({ id: 'dose-1', highRiskSideEffects: [] })],
      [log({ severity: RECONCILIATION_MIN_SEVERITY })],
    );

    const entry = timeline.entries[0];
    expect(entry.isRedFlag).toBe(true);
    expect(timeline.redFlagCount).toBe(1);
    // No check-in is owed, so no check-in state — but the flag still surfaces.
    expect(entry.checkInState).toBe(null);
  });

  it('stays clean below the reconciliation band', () => {
    const timeline = buildSideEffectTimeline(
      [dose()],
      [log({ severity: RECONCILIATION_MIN_SEVERITY - 1 })],
    );

    expect(timeline.entries[0].isRedFlag).toBe(false);
    expect(timeline.entries[0].checkInState).toBe('clean');
    expect(timeline.entries[0].logs[0].reconciliationPrompt).toBe('');
  });

  it('attaches logs to their own dose and counts every flagged report', () => {
    const timeline = buildSideEffectTimeline(
      [
        dose({ id: 'dose-1' }),
        dose({
          id: 'dose-2',
          medicationName: 'Calcium Carbonate',
          highRiskSideEffects: [],
          scheduledFor: '2026-09-17T12:00:00.000Z',
        }),
      ],
      [
        log({ id: 'log-1', dailyScheduleId: 'dose-1', severity: 4 }),
        log({ id: 'log-2', dailyScheduleId: 'dose-1', severity: 1 }),
        log({ id: 'log-3', dailyScheduleId: 'dose-2', severity: 1 }),
      ],
    );

    expect(timeline.entries[0].logs).toHaveLength(2);
    expect(timeline.entries[0].checkInState).toBe('red_flag');
    expect(timeline.entries[1].logs).toHaveLength(1);
    expect(timeline.redFlagCount).toBe(1);
  });

  it('carries the dose adherence status through for the PDF timeline', () => {
    const timeline = buildSideEffectTimeline([dose({ adherenceStatus: 'ESCALATED' })], []);

    expect(timeline.entries[0].adherenceStatus).toBe('ESCALATED');
  });
});
