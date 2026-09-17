import { describe, expect, it } from 'vitest';
import { computeWakeDeltaMinutes, recalculateDynamicSchedule } from '@/lib/engines/schedule-solver';
import type { DoseEvent, MedicationBufferRequirement } from '@/lib/engines/types';

// Canonical PRD §4 fixture day: wake 07:00, levothyroxine on waking, calcium
// 90 minutes later, bedtime 22:00. All instants are UTC (storage format).
const OLD_WAKE = '2026-09-17T07:00:00.000Z';
const NEW_WAKE = '2026-09-17T09:30:00.000Z'; // +150 minutes — the PRD worked case
const BEDTIME = '2026-09-17T22:00:00.000Z';
const LEVO = 'med-levothyroxine';
const CALCIUM = 'med-calcium-carbonate';
/** PRD §4: levothyroxine must be separated 2 hours from calcium carbonate. */
const LEVO_CALCIUM_BUFFER: MedicationBufferRequirement[] = [
  { medicationId: LEVO, pairedWithMedicationId: CALCIUM, minBufferMinutes: 120, bufferType: 'absorption' },
];

function dose(id: string, medicationId: string, scheduledFor: string, adherenceStatus: DoseEvent['adherenceStatus'] = 'PENDING'): DoseEvent {
  return { id, medicationId, scheduledFor, adherenceStatus };
}

describe('computeWakeDeltaMinutes', () => {
  it('computes the wake delta in minutes', () => {
    expect(computeWakeDeltaMinutes(OLD_WAKE, NEW_WAKE)).toBe(150);
  });

  it('clamps an earlier wake input to zero — nothing earlier in the day is rewritten', () => {
    expect(computeWakeDeltaMinutes(OLD_WAKE, '2026-09-17T06:00:00.000Z')).toBe(0);
  });
});

describe('recalculateDynamicSchedule — PRD worked case (wake 07:00 → 09:30, levothyroxine held 2h from calcium)', () => {
  it('shifts levothyroxine to the new wake and pushes calcium forward to hold the 2-hour gap', () => {
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z'),
        dose('dose-calcium', CALCIUM, '2026-09-17T08:30:00.000Z'), // 90 min gap < 120 → push
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    expect(result.wakeDeltaMinutes).toBe(150);

    const levo = result.doses.find((d) => d.id === 'dose-levo');
    const calcium = result.doses.find((d) => d.id === 'dose-calcium');
    expect(levo).toBeDefined();
    expect(calcium).toBeDefined();

    // Levothyroxine rides the wake delta: 07:00 + 150 min = 09:30.
    expect(levo!.newScheduledFor).toBe('2026-09-17T09:30:00.000Z');
    expect(levo!.deferredReason).toBe('wake_shift');
    expect(levo!.isPastBedtimeWarning).toBe(false);

    // Calcium shifts to 11:00, then the buffer pushes it forward to 11:30
    // (levothyroxine 09:30 + 120 min) — pushed FORWARD, never earlier.
    expect(calcium!.newScheduledFor).toBe('2026-09-17T11:30:00.000Z');
    expect(calcium!.deferredReason).toBe('buffer_push');
    expect(calcium!.isPastBedtimeWarning).toBe(false);

    // The enforced gap is exactly the minimum.
    expect(
      (new Date(calcium!.newScheduledFor).getTime() - new Date(levo!.newScheduledFor).getTime()) / 60_000,
    ).toBe(120);
    expect(result.hasBedtimeWarnings).toBe(false);
  });

  it('leaves the pair untouched when the shifted gap already satisfies the buffer', () => {
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z'),
        dose('dose-calcium', CALCIUM, '2026-09-17T09:00:00.000Z'), // shifts to 11:30 = levo + 120
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    const calcium = result.doses.find((d) => d.id === 'dose-calcium')!;
    expect(calcium.newScheduledFor).toBe('2026-09-17T11:30:00.000Z');
    expect(calcium.deferredReason).toBe('wake_shift'); // delta alone already satisfies the buffer
  });
});

describe('recalculateDynamicSchedule — confirmed-dose freeze', () => {
  it('never rewrites a CONFIRMED dose and pushes the pending partner past it', () => {
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-calcium', CALCIUM, '2026-09-17T08:30:00.000Z', 'CONFIRMED'),
        dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z'), // shifts to 09:30, 60 min after confirmed calcium
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    const calcium = result.doses.find((d) => d.id === 'dose-calcium')!;
    expect(calcium.newScheduledFor).toBe('2026-09-17T08:30:00.000Z'); // frozen
    expect(calcium.frozen).toBe(true);
    expect(calcium.wasShifted).toBe(false);
    expect(calcium.deferredReason).toBeNull();

    // Levothyroxine is pushed forward past the frozen calcium: 08:30 + 120 = 10:30.
    const levo = result.doses.find((d) => d.id === 'dose-levo')!;
    expect(levo.newScheduledFor).toBe('2026-09-17T10:30:00.000Z');
    expect(levo.deferredReason).toBe('buffer_push');
    expect(levo.frozen).toBe(false);
  });

  it('leaves SKIPPED doses frozen too', () => {
    const result = recalculateDynamicSchedule({
      doses: [dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z', 'SKIPPED')],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: [],
    });

    expect(result.doses[0]).toMatchObject({
      id: 'dose-levo',
      newScheduledFor: '2026-09-17T07:00:00.000Z',
      frozen: true,
      wasShifted: false,
      deferredReason: null,
    });
  });

  it('shifts ESCALATED doses — they are still unresolved', () => {
    const result = recalculateDynamicSchedule({
      doses: [dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z', 'ESCALATED')],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: [],
    });

    expect(result.doses[0]).toMatchObject({
      newScheduledFor: '2026-09-17T09:30:00.000Z',
      frozen: false,
      deferredReason: 'wake_shift',
    });
  });
});

describe('recalculateDynamicSchedule — forward-only rule', () => {
  it('never moves any dose earlier than its original anchor, even with a clamped delta', () => {
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z'),
        dose('dose-calcium', CALCIUM, '2026-09-17T08:30:00.000Z'),
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: '2026-09-17T05:00:00.000Z', // earlier wake — clamped to zero delta
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    for (const shifted of result.doses) {
      expect(new Date(shifted.newScheduledFor).getTime()).toBeGreaterThanOrEqual(
        new Date(shifted.originalScheduledFor).getTime(),
      );
    }
    expect(result.wakeDeltaMinutes).toBe(0);
  });

  it('pushes a buffer-violating dose forward, never pulls its partner earlier', () => {
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z'),
        dose('dose-calcium', CALCIUM, '2026-09-17T07:30:00.000Z'), // 30 min gap — far short
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: OLD_WAKE, // no wake change — pure buffer repair
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    const levo = result.doses.find((d) => d.id === 'dose-levo')!;
    const calcium = result.doses.find((d) => d.id === 'dose-calcium')!;
    expect(levo.newScheduledFor).toBe('2026-09-17T07:00:00.000Z'); // untouched
    expect(calcium.newScheduledFor).toBe('2026-09-17T09:00:00.000Z'); // 07:00 + 120
    expect(calcium.deferredReason).toBe('buffer_push');
  });

  it('satisfies a buffer exactly at the minimum without pushing', () => {
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z'),
        dose('dose-calcium', CALCIUM, '2026-09-17T09:00:00.000Z'), // exactly 120
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: OLD_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    const calcium = result.doses.find((d) => d.id === 'dose-calcium')!;
    expect(calcium.newScheduledFor).toBe('2026-09-17T09:00:00.000Z');
    expect(calcium.deferredReason).toBeNull();
  });
});

describe('recalculateDynamicSchedule — bedtime warning', () => {
  it('flags doses that land past bedtime and reports it at the top level', () => {
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-evening', 'med-metformin', '2026-09-17T21:30:00.000Z'), // +150 → 00:00 next day
        dose('dose-morning', LEVO, '2026-09-17T07:00:00.000Z'),
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: [],
    });

    const evening = result.doses.find((d) => d.id === 'dose-evening')!;
    const morning = result.doses.find((d) => d.id === 'dose-morning')!;
    expect(evening.isPastBedtimeWarning).toBe(true);
    expect(morning.isPastBedtimeWarning).toBe(false);
    expect(result.hasBedtimeWarnings).toBe(true);
  });

  it('preserves a frozen dose existing bedtime flag without recomputing it', () => {
    const result = recalculateDynamicSchedule({
      doses: [{ ...dose('dose-levo', LEVO, '2026-09-17T23:00:00.000Z', 'CONFIRMED'), isPastBedtimeWarning: true }],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: [],
    });

    expect(result.doses[0]).toMatchObject({ frozen: true, isPastBedtimeWarning: true });
    expect(result.hasBedtimeWarnings).toBe(true);
  });
});

describe('recalculateDynamicSchedule — determinism and shape', () => {
  it('sorts output by new scheduled time regardless of input order', () => {
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-calcium', CALCIUM, '2026-09-17T08:30:00.000Z'),
        dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z'),
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    expect(result.doses.map((d) => d.id)).toEqual(['dose-levo', 'dose-calcium']);
  });

  it('enforces the pair whichever dose is placed second for concurrent doses', () => {
    // Concurrent doses (same anchor, id tie-break: dose-a-levo < dose-b-calcium):
    // levothyroxine keeps the slot, calcium is pushed forward.
    const result = recalculateDynamicSchedule({
      doses: [
        dose('dose-b-calcium', CALCIUM, '2026-09-17T07:00:00.000Z'),
        dose('dose-a-levo', LEVO, '2026-09-17T07:00:00.000Z'),
      ],
      oldWakeTime: OLD_WAKE,
      newWakeTime: OLD_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    const calcium = result.doses.find((d) => d.id === 'dose-b-calcium')!;
    const levo = result.doses.find((d) => d.id === 'dose-a-levo')!;
    expect(levo.newScheduledFor).toBe('2026-09-17T07:00:00.000Z');
    expect(calcium.newScheduledFor).toBe('2026-09-17T09:00:00.000Z');
  });

  it('ignores buffer pairs when only one side is present today', () => {
    const result = recalculateDynamicSchedule({
      doses: [dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z')],
      oldWakeTime: OLD_WAKE,
      newWakeTime: NEW_WAKE,
      bedtime: BEDTIME,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
    });

    expect(result.doses[0].newScheduledFor).toBe('2026-09-17T09:30:00.000Z');
    expect(result.doses[0].deferredReason).toBe('wake_shift');
  });

  it('rejects a negative minBufferMinutes instead of silently accepting it', () => {
    expect(() =>
      recalculateDynamicSchedule({
        doses: [dose('dose-levo', LEVO, '2026-09-17T07:00:00.000Z')],
        oldWakeTime: OLD_WAKE,
        newWakeTime: NEW_WAKE,
        bedtime: BEDTIME,
        bufferRequirements: [
          { medicationId: LEVO, pairedWithMedicationId: CALCIUM, minBufferMinutes: -5, bufferType: 'absorption' },
        ],
      }),
    ).toThrow(RangeError);
  });

  it('throws on unparseable dose timestamps', () => {
    expect(() =>
      recalculateDynamicSchedule({
        doses: [dose('dose-levo', LEVO, 'not-a-timestamp')],
        oldWakeTime: OLD_WAKE,
        newWakeTime: NEW_WAKE,
        bedtime: BEDTIME,
        bufferRequirements: [],
      }),
    ).toThrow(RangeError);
  });
});
