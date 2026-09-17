import { describe, expect, it } from 'vitest';
import { parseInboundCommand, resolveEarliestPendingDose } from '@/lib/engines/dose-resolution';
import type { DoseEvent } from '@/lib/engines/types';

function dose(id: string, scheduledFor: string, adherenceStatus: DoseEvent['adherenceStatus'] = 'PENDING'): DoseEvent {
  return { id, medicationId: `med-${id}`, scheduledFor, adherenceStatus };
}

describe('resolveEarliestPendingDose — earliest-pending resolution for concurrent doses', () => {
  it('resolves to the earliest-scheduled pending row', () => {
    const picked = resolveEarliestPendingDose([
      dose('late', '2026-09-17T15:00:00.000Z'),
      dose('early', '2026-09-17T13:00:00.000Z'),
      dose('middle', '2026-09-17T14:00:00.000Z'),
    ]);
    expect(picked!.id).toBe('early');
  });

  it('breaks exact ties deterministically by id', () => {
    const sameTime = '2026-09-17T14:00:00.000Z';
    const picked = resolveEarliestPendingDose([
      dose('beta-dose', sameTime),
      dose('alpha-dose', sameTime),
      dose('gamma-dose', sameTime),
    ]);
    expect(picked!.id).toBe('alpha-dose');
  });

  it('excludes resolved doses from resolution', () => {
    const picked = resolveEarliestPendingDose([
      dose('confirmed-early', '2026-09-17T13:00:00.000Z', 'CONFIRMED'),
      dose('skipped-early', '2026-09-17T13:30:00.000Z', 'SKIPPED'),
      dose('still-pending', '2026-09-17T15:00:00.000Z'),
    ]);
    expect(picked!.id).toBe('still-pending');
  });

  it('treats an ESCALATED dose as confirmable and resolves it when earliest', () => {
    const picked = resolveEarliestPendingDose([
      dose('escalated', '2026-09-17T13:00:00.000Z', 'ESCALATED'),
      dose('pending-later', '2026-09-17T18:00:00.000Z'),
    ]);
    expect(picked!.id).toBe('escalated');
  });

  it('prefers the earlier pending row even when it is escalated versus a later pending one', () => {
    const picked = resolveEarliestPendingDose([
      dose('pending-late', '2026-09-17T16:00:00.000Z'),
      dose('escalated-early', '2026-09-17T13:00:00.000Z', 'ESCALATED'),
    ]);
    expect(picked!.id).toBe('escalated-early');
  });

  it('returns null with no doses', () => {
    expect(resolveEarliestPendingDose([])).toBeNull();
  });

  it('returns null when nothing is confirmable', () => {
    expect(
      resolveEarliestPendingDose([
        dose('a', '2026-09-17T13:00:00.000Z', 'CONFIRMED'),
        dose('b', '2026-09-17T14:00:00.000Z', 'SKIPPED'),
      ]),
    ).toBeNull();
  });

  it('is deterministic under input shuffling', () => {
    const doses = [
      dose('c-dose', '2026-09-17T14:00:00.000Z'),
      dose('a-dose', '2026-09-17T12:00:00.000Z'),
      dose('b-dose', '2026-09-17T16:00:00.000Z'),
    ];
    const forward = resolveEarliestPendingDose(doses);
    const reversed = resolveEarliestPendingDose([...doses].reverse());
    expect(forward).toEqual(reversed);
    expect(forward!.id).toBe('a-dose');
  });
});

describe('parseInboundCommand — PRD §5 SMS protocol parsing', () => {
  it('parses every confirmation keyword, case-insensitively', () => {
    expect(parseInboundCommand('1')).toEqual({ kind: 'confirm' });
    expect(parseInboundCommand('yes')).toEqual({ kind: 'confirm' });
    expect(parseInboundCommand('  CONFIRMED ')).toEqual({ kind: 'confirm' });
  });

  it('parses skip/denial keywords', () => {
    expect(parseInboundCommand('NO')).toEqual({ kind: 'skip' });
    expect(parseInboundCommand('skip')).toEqual({ kind: 'skip' });
  });

  it('parses the DIZZY YES / DIZZY NO symptom protocol into a symptom report', () => {
    expect(parseInboundCommand('DIZZY YES')).toEqual({ kind: 'symptom_report', canonicalSymptom: 'dizziness', affirmed: true });
    expect(parseInboundCommand('dizzy no')).toEqual({ kind: 'symptom_report', canonicalSymptom: 'dizziness', affirmed: false });
  });

  it('never guesses an unrecognized symptom — DIZZY YES is protocol, RASH YES is not', () => {
    expect(parseInboundCommand('RASH YES')).toEqual({ kind: 'unknown' });
  });

  it('classifies arbitrary text as unknown rather than a command', () => {
    expect(parseInboundCommand('what about my evening dose?')).toEqual({ kind: 'unknown' });
    expect(parseInboundCommand('')).toEqual({ kind: 'unknown' });
  });

  it('does not parse a bare symptom word as a report — the protocol requires an answer', () => {
    expect(parseInboundCommand('DIZZY')).toEqual({ kind: 'unknown' });
  });

  it('rejects three-word and malformed multi-word bodies', () => {
    expect(parseInboundCommand('DIZZY YES TODAY')).toEqual({ kind: 'unknown' });
    expect(parseInboundCommand('YES NO')).toEqual({ kind: 'unknown' });
  });
});
