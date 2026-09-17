/**
 * VoyagerAudioEngine — Web Audio feedback per PRD §6.
 *
 * - Keypad beep: 784 Hz sine, short envelope.
 * - Red alert: 440 → 880 Hz sawtooth sweep.
 *
 * The AudioContext is created lazily inside the first play call, and the UI
 * must originate that call from a user-gesture handler (browser autoplay
 * policy) — initialization happens only after first user interaction.
 *
 * Web Audio is reached through the AudioContextLike structural interface so
 * tests inject a deterministic fake instead of a real AudioContext.
 */

export const KEYPAD_BEEP_HZ = 784;
export const KEYPAD_BEEP_SECONDS = 0.08;
export const KEYPAD_BEEP_GAIN = 0.15;
export const RED_ALERT_START_HZ = 440;
export const RED_ALERT_END_HZ = 880;
export const RED_ALERT_SECONDS = 0.6;
export const RED_ALERT_GAIN = 0.12;

/** Result instead of thrown errors: audio never crashes the app. */
export type AudioPlayResult = { ok: true } | { ok: false; reason: string };

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): this;
  exponentialRampToValueAtTime(value: number, endTime: number): this;
}

export interface EngineAudioNode {
  connect(destination: EngineAudioNode | null): void;
}

export interface EngineOscillator extends EngineAudioNode {
  type: OscillatorType;
  readonly frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface EngineGainNode extends EngineAudioNode {
  readonly gain: AudioParamLike;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: EngineAudioNode;
  createOscillator(): EngineOscillator;
  createGain(): EngineGainNode;
  resume(): Promise<void>;
}

export interface OscillatorPlan {
  type: OscillatorType;
  fromHz: number;
  toHz: number;
  durationSeconds: number;
  gain: number;
}

/** Pure event plans — the testable contract of each cue (PRD §6). */
export function keypadBeepPlan(): OscillatorPlan {
  return {
    type: 'sine',
    fromHz: KEYPAD_BEEP_HZ,
    toHz: KEYPAD_BEEP_HZ,
    durationSeconds: KEYPAD_BEEP_SECONDS,
    gain: KEYPAD_BEEP_GAIN,
  };
}

export function redAlertPlan(): OscillatorPlan {
  return {
    type: 'sawtooth',
    fromHz: RED_ALERT_START_HZ,
    toHz: RED_ALERT_END_HZ,
    durationSeconds: RED_ALERT_SECONDS,
    gain: RED_ALERT_GAIN,
  };
}

type ContextFactory = () => AudioContextLike;

function defaultContextFactory(): AudioContextLike {
  if (!window.AudioContext) {
    throw new Error('Web Audio is not supported in this browser');
  }
  return new window.AudioContext();
}

export class VoyagerAudioEngine {
  private context: AudioContextLike | null = null;
  private readonly contextFactory: ContextFactory;

  constructor(contextFactory: ContextFactory = defaultContextFactory) {
    this.contextFactory = contextFactory;
  }

  get isInitialized(): boolean {
    return this.context !== null;
  }

  /**
   * Creates the AudioContext on first use. Call only from a user-gesture
   * handler; browsers refuse to start audio outside one.
   */
  ensureInitialized(): boolean {
    if (typeof window === 'undefined') return false;
    if (this.context) return true;
    try {
      this.context = this.contextFactory();
      return true;
    } catch (cause) {
      console.error('VoyagerAudioEngine: context creation failed', cause);
      return false;
    }
  }

  keypadBeep(): AudioPlayResult {
    return this.play(keypadBeepPlan());
  }

  redAlert(): AudioPlayResult {
    return this.play(redAlertPlan());
  }

  private play(plan: OscillatorPlan): AudioPlayResult {
    if (typeof window === 'undefined') {
      return { ok: false, reason: 'audio is unavailable outside the browser' };
    }
    if (!this.ensureInitialized() || !this.context) {
      return { ok: false, reason: 'audio initialization failed' };
    }
    const context = this.context;
    try {
      context.resume().catch((cause: unknown) => {
        console.error('VoyagerAudioEngine: resume failed', cause);
      });
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = plan.type;
      oscillator.frequency.setValueAtTime(plan.fromHz, now);
      if (plan.toHz !== plan.fromHz) {
        oscillator.frequency.exponentialRampToValueAtTime(
          plan.toHz,
          now + plan.durationSeconds,
        );
      }
      gain.gain.setValueAtTime(plan.gain, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + plan.durationSeconds);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + plan.durationSeconds);
      return { ok: true };
    } catch (cause) {
      console.error('VoyagerAudioEngine: playback failed', cause);
      return { ok: false, reason: 'audio playback failed' };
    }
  }
}

/** Shared application engine instance. */
export const voyagerAudio = new VoyagerAudioEngine();
