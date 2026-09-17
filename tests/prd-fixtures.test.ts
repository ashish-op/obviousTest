import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_FIXTURES,
  CONFIRMATION_KEYWORDS,
  ESCALATION_EXAMPLE,
  SYMPTOM_PROTOCOL,
  WORKED_CASE,
  LEVO_CALCIUM_BUFFER,
} from './fixtures/prd-cases';
import {
  ESCALATION_DELAY_MINUTES,
  computeEscalationDeliverAt,
  canonicalizeSymptomKeyword,
  evaluateExtractionConfidence,
  parseInboundCommand,
} from '@/lib/engines';
import { recalculateDynamicSchedule } from '@/lib/engines/schedule-solver';

describe('PRD §4 worked case — wake 07:00 → 09:30, levothyroxine held 2 h from calcium', () => {
  it('reproduces the canonical fixture exactly', () => {
    const result = recalculateDynamicSchedule(WORKED_CASE);

    const levo = result.doses.find((d) => d.id === 'dose-levo')!;
    const calcium = result.doses.find((d) => d.id === 'dose-calcium')!;

    // Levothyroxine rides the wake delta exactly: 07:00 + 150 min = 09:30.
    expect(levo.newScheduledFor).toBe('2026-09-17T09:30:00.000Z');
    expect(levo.deferredReason).toBe('wake_shift');

    // Calcium shifts to 11:00, then the 2-hour absorption buffer pushes it
    // forward (never earlier) to 11:30.
    expect(calcium.newScheduledFor).toBe('2026-09-17T11:30:00.000Z');
    expect(calcium.deferredReason).toBe('buffer_push');

    // The enforced gap is exactly the minimum, in the correct direction.
    expect(
      (new Date(calcium.newScheduledFor).getTime() - new Date(levo.newScheduledFor).getTime()) / 60_000,
    ).toBe(120);

    expect(result.wakeDeltaMinutes).toBe(150);
    expect(result.hasBedtimeWarnings).toBe(false);
  });

  it('keeps the worked case valid as a ScheduleShiftInput', () => {
    // The fixture itself encodes the PRD's 150-minute wake delta.
    const delta = new Date(WORKED_CASE.newWakeTime).getTime() - new Date(WORKED_CASE.oldWakeTime).getTime();
    expect(delta).toBe(150 * 60 * 1000);
  });
});

describe('PRD §3 confidence fixtures — one gate, both branches', () => {
  it('routes each fixture score to its PRD-defined branch', () => {
    expect(evaluateExtractionConfidence(CONFIDENCE_FIXTURES.below)).toBe('low_confidence_review');
    expect(evaluateExtractionConfidence(CONFIDENCE_FIXTURES.atThreshold)).toBe('auto_populate');
    expect(evaluateExtractionConfidence(CONFIDENCE_FIXTURES.above)).toBe('auto_populate');
  });
});

describe('PRD §5 SMS protocol fixtures — keywords route through the engines', () => {
  it('parses every confirmation keyword to the confirm command', () => {
    for (const keyword of CONFIRMATION_KEYWORDS) {
      expect(parseInboundCommand(keyword)).toEqual({ kind: 'confirm' });
    }
  });

  it('round-trips the DIZZY symptom protocol in both directions', () => {
    expect(canonicalizeSymptomKeyword(SYMPTOM_PROTOCOL.flagKeyword)).toBe(SYMPTOM_PROTOCOL.canonicalSymptom);
    expect(parseInboundCommand(SYMPTOM_PROTOCOL.affirm)).toEqual({
      kind: 'symptom_report',
      canonicalSymptom: 'dizziness',
      affirmed: true,
    });
    expect(parseInboundCommand(SYMPTOM_PROTOCOL.deny)).toEqual({
      kind: 'symptom_report',
      canonicalSymptom: 'dizziness',
      affirmed: false,
    });
  });
});

describe('PRD §5 escalation fixture — missed at 3 PM, caregiver at 3:45 PM', () => {
  it('lands exactly on the fixture time with the PRD constant', () => {
    expect(ESCALATION_DELAY_MINUTES).toBe(45);
    expect(computeEscalationDeliverAt(ESCALATION_EXAMPLE.scheduledFor).toISOString()).toBe(
      ESCALATION_EXAMPLE.escalatesAt,
    );
  });
});

describe('PRD §2 confirmed-dose fixture — frozen across recalculation', () => {
  it('a confirmed levothyroxine dose never moves; its pending partner clears the buffer', () => {
    const result = recalculateDynamicSchedule({
      ...WORKED_CASE,
      bufferRequirements: LEVO_CALCIUM_BUFFER,
      doses: [
        { id: 'dose-levo', medicationId: 'med-levothyroxine', scheduledFor: '2026-09-17T07:00:00.000Z', adherenceStatus: 'CONFIRMED' },
        { id: 'dose-calcium', medicationId: 'med-calcium-carbonate', scheduledFor: '2026-09-17T08:30:00.000Z', adherenceStatus: 'PENDING' },
      ],
    });

    const frozen = result.doses.find((d) => d.id === 'dose-levo')!;
    const calcium = result.doses.find((d) => d.id === 'dose-calcium')!;

    expect(frozen.newScheduledFor).toBe('2026-09-17T07:00:00.000Z');
    expect(frozen.frozen).toBe(true);
    // Calcium rides the delta to 11:00 — already 4 h past the frozen anchor,
    // so no buffer push is needed.
    expect(calcium.newScheduledFor).toBe('2026-09-17T11:00:00.000Z');
    expect(calcium.deferredReason).toBe('wake_shift');
  });
});

describe('fixture hygiene', () => {
  it('fixture dose ids are unique within the worked case', () => {
    expect(new Set(WORKED_CASE.doses.map((dose) => dose.id)).size).toBe(WORKED_CASE.doses.length);
  });

  it('the fixture buffer pair references fixture medication ids', () => {
    const medicationIds = new Set(WORKED_CASE.doses.map((dose) => dose.medicationId));
    for (const requirement of WORKED_CASE.bufferRequirements) {
      expect(medicationIds.has(requirement.medicationId)).toBe(true);
      expect(medicationIds.has(requirement.pairedWithMedicationId)).toBe(true);
    }
  });
});
