import { describe, expect, it } from 'vitest';
import {
  ESCALATION_DELAY_MINUTES,
  computeEscalationDeliverAt,
  nextDoseStatus,
  planEscalation,
  selectDueEscalations,
  shouldEscalateDose,
} from '@/lib/engines/escalation';
import type { EscalationJobView } from '@/lib/engines/types';

// Fixed clock: dose scheduled at 15:00 (the PRD's "missed dose at 3 PM" case).
const DOSE_TIME = '2026-09-17T15:00:00.000Z';
const at = (iso: string) => new Date(iso);

describe('ESCALATION_DELAY_MINUTES', () => {
  it('is the PRD §5 constant of 45 minutes', () => {
    expect(ESCALATION_DELAY_MINUTES).toBe(45);
  });
});

describe('computeEscalationDeliverAt — fixed-clock escalation scheduling', () => {
  it('fires exactly 45 minutes after the scheduled time', () => {
    expect(computeEscalationDeliverAt(DOSE_TIME).toISOString()).toBe('2026-09-17T15:45:00.000Z');
  });

  it('crosses hour boundaries cleanly', () => {
    expect(computeEscalationDeliverAt('2026-09-17T15:30:00.000Z').toISOString()).toBe('2026-09-17T16:15:00.000Z');
  });

  it('plans a persisted job row with the dose id', () => {
    expect(planEscalation({ id: 'dose-42' }, DOSE_TIME)).toEqual({
      dailyScheduleId: 'dose-42',
      deliverAt: '2026-09-17T15:45:00.000Z',
    });
  });
});

describe('shouldEscalateDose — injected clock', () => {
  it('is false 44 minutes after the scheduled time', () => {
    expect(shouldEscalateDose({ adherenceStatus: 'PENDING', scheduledFor: DOSE_TIME }, at('2026-09-17T15:44:00.000Z'))).toBe(false);
  });

  it('is true exactly 45 minutes after the scheduled time', () => {
    expect(shouldEscalateDose({ adherenceStatus: 'PENDING', scheduledFor: DOSE_TIME }, at('2026-09-17T15:45:00.000Z'))).toBe(true);
  });

  it('stays true beyond the window', () => {
    expect(shouldEscalateDose({ adherenceStatus: 'PENDING', scheduledFor: DOSE_TIME }, at('2026-09-17T16:02:00.000Z'))).toBe(true);
  });

  it('never escalates a dose that is no longer pending', () => {
    const now = at('2026-09-17T16:00:00.000Z');
    expect(shouldEscalateDose({ adherenceStatus: 'CONFIRMED', scheduledFor: DOSE_TIME }, now)).toBe(false);
    expect(shouldEscalateDose({ adherenceStatus: 'ESCALATED', scheduledFor: DOSE_TIME }, now)).toBe(false);
    expect(shouldEscalateDose({ adherenceStatus: 'SKIPPED', scheduledFor: DOSE_TIME }, now)).toBe(false);
  });
});

describe('selectDueEscalations — sweep selection at an injected now', () => {
  const jobs: EscalationJobView[] = [
    { id: 'job-c', deliverAt: '2026-09-17T16:00:00.000Z', status: 'pending' },
    { id: 'job-a', deliverAt: '2026-09-17T15:45:00.000Z', status: 'pending' },
    { id: 'job-b', deliverAt: '2026-09-17T15:30:00.000Z', status: 'dispatched' }, // already sent
    { id: 'job-d', deliverAt: '2026-09-17T15:00:00.000Z', status: 'cancelled' }, // cancelled
    { id: 'job-e', deliverAt: '2026-09-17T16:30:00.000Z', status: 'pending' }, // future
  ];

  it('returns nothing before any window opens', () => {
    expect(selectDueEscalations(jobs, at('2026-09-17T15:44:00.000Z'))).toEqual([]);
  });

  it('returns only pending jobs whose deliverAt has arrived, in dispatch order', () => {
    const due = selectDueEscalations(jobs, at('2026-09-17T16:00:00.000Z'));
    expect(due.map((job) => job.id)).toEqual(['job-a', 'job-c']);
  });

  it('keeps a due job due — repeated sweeps see it until the runner dispatches it, including later arrivals', () => {
    // By 17:00 job-e (16:30, pending) has also come due — selection is time-relative.
    const due = selectDueEscalations(jobs, at('2026-09-17T17:00:00.000Z'));
    expect(due.map((job) => job.id)).toEqual(['job-a', 'job-c', 'job-e']);
  });

  it('is deterministic regardless of input order', () => {
    const dueA = selectDueEscalations(jobs, at('2026-09-17T16:00:00.000Z'));
    const dueB = selectDueEscalations([...jobs].reverse(), at('2026-09-17T16:00:00.000Z'));
    expect(dueA).toEqual(dueB);
  });
});

describe('nextDoseStatus — PRD §2 lifecycle transitions', () => {
  it('confirms a pending dose', () => {
    expect(nextDoseStatus('PENDING', 'confirm')).toBe('CONFIRMED');
  });

  it('confirms an escalated dose late — the patient answers after the caregiver notice', () => {
    expect(nextDoseStatus('ESCALATED', 'confirm')).toBe('CONFIRMED');
  });

  it('treats re-confirmation as idempotent', () => {
    expect(nextDoseStatus('CONFIRMED', 'confirm')).toBe('CONFIRMED');
  });

  it('rejects confirming a skipped dose', () => {
    expect(nextDoseStatus('SKIPPED', 'confirm')).toBeNull();
  });

  it('skips pending and escalated doses', () => {
    expect(nextDoseStatus('PENDING', 'skip')).toBe('SKIPPED');
    expect(nextDoseStatus('ESCALATED', 'skip')).toBe('SKIPPED');
  });

  it('rejects skipping resolved doses', () => {
    expect(nextDoseStatus('CONFIRMED', 'skip')).toBeNull();
    expect(nextDoseStatus('SKIPPED', 'skip')).toBeNull();
  });
});
