// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  KEYPAD_BEEP_HZ,
  RED_ALERT_END_HZ,
  RED_ALERT_START_HZ,
  VoyagerAudioEngine,
  keypadBeepPlan,
  redAlertPlan,
  type AudioContextLike,
} from '@/lib/audio/voyager-audio-engine';

function fakeParam(initial: number) {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

/** Minimal AudioContextLike double capturing oscillator wiring. */
function makeFakeContext(currentTime = 5) {
  const oscillator = {
    type: 'sine' as OscillatorType,
    frequency: fakeParam(0),
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = {
    gain: fakeParam(0),
    connect: vi.fn(),
  };
  const context: AudioContextLike = {
    currentTime,
    destination: { connect: vi.fn() },
    createOscillator: () => oscillator,
    createGain: () => gain,
    resume: async () => {},
  };
  return { context, oscillator, gain };
}

describe('VoyagerAudioEngine — PRD §6 audio plans', () => {
  it('keypad beep is a 784 Hz sine (PRD §6)', () => {
    expect(KEYPAD_BEEP_HZ).toBe(784);
    expect(keypadBeepPlan()).toMatchObject({
      type: 'sine',
      fromHz: 784,
      toHz: 784,
    });
  });

  it('red alert is a 440 → 880 Hz sawtooth sweep (PRD §6)', () => {
    expect(RED_ALERT_START_HZ).toBe(440);
    expect(RED_ALERT_END_HZ).toBe(880);
    expect(redAlertPlan()).toMatchObject({
      type: 'sawtooth',
      fromHz: 440,
      toHz: 880,
    });
  });
});

describe('VoyagerAudioEngine — init only after first interaction', () => {
  it('creates no AudioContext until the first play call', () => {
    const { context } = makeFakeContext();
    const factory = vi.fn(() => context);
    const engine = new VoyagerAudioEngine(factory);
    expect(engine.isInitialized).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it('initializes on first play and wires the keypad beep at 784 Hz', () => {
    const { context, oscillator, gain } = makeFakeContext();
    const factory = vi.fn(() => context);
    const engine = new VoyagerAudioEngine(factory);

    const result = engine.keypadBeep();

    expect(result).toEqual({ ok: true });
    expect(engine.isInitialized).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(oscillator.type).toBe('sine');
    expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(784, 5);
    // Constant frequency: no sweep on the oscillator.
    expect(oscillator.frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    // Decaying gain envelope into the destination.
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalled();
    expect(oscillator.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    expect(oscillator.start).toHaveBeenCalled();
    expect(oscillator.stop).toHaveBeenCalled();
  });

  it('sweeps the red alert 440 → 880 Hz', () => {
    const { context, oscillator } = makeFakeContext();
    const engine = new VoyagerAudioEngine(() => context);

    const result = engine.redAlert();

    expect(result).toEqual({ ok: true });
    expect(oscillator.type).toBe('sawtooth');
    expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(440, 5);
    expect(oscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      880,
      5 + 0.6,
    );
  });

  it('reuses one context across plays — the factory runs exactly once', () => {
    const { context } = makeFakeContext();
    const factory = vi.fn(() => context);
    const engine = new VoyagerAudioEngine(factory);

    engine.keypadBeep();
    engine.redAlert();
    engine.keypadBeep();

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reports a failure result instead of throwing when audio init fails', () => {
    const engine = new VoyagerAudioEngine(() => {
      throw new Error('Web Audio is not supported in this browser');
    });
    const result = engine.keypadBeep();
    expect(result).toEqual({ ok: false, reason: 'audio initialization failed' });
  });
});
