'use client';

import { useState } from 'react';
import {
  voyagerAudio,
  type AudioPlayResult,
} from '@/lib/audio/voyager-audio-engine';

type Theme = 'dark' | 'light';

/**
 * Page-level demo controls: theme switch and the two PRD §6 audio cues.
 * Deliberately not a primitive — this owns interaction state. Both audio
 * buttons are user-gesture handlers, which is what licenses audio init.
 */
export function DemoControls() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [audioFailure, setAudioFailure] = useState<string | null>(null);

  function toggleTheme(): void {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }

  function play(result: AudioPlayResult): void {
    setAudioFailure(result.ok ? null : result.reason);
  }

  return (
    <div className="lcars-controls">
      <button
        type="button"
        className="lcars-button lcars-button--lavender"
        onClick={toggleTheme}
      >
        Theme: {theme}
      </button>
      <button
        type="button"
        className="lcars-button lcars-button--gold"
        onClick={() => play(voyagerAudio.keypadBeep())}
      >
        Keypad beep · 784 Hz
      </button>
      <button
        type="button"
        className="lcars-button lcars-button--alert"
        onClick={() => play(voyagerAudio.redAlert())}
      >
        Red alert · 440→880 Hz
      </button>
      {audioFailure ? (
        <p role="alert" className="lcars-disclaimer__error">
          {audioFailure}
        </p>
      ) : null}
    </div>
  );
}
