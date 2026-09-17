import type { ReactNode } from 'react';

export type LcarsPanelTone = 'panel' | 'frame' | 'gold' | 'ice';

export interface LcarsPanelProps {
  /** Uppercase caption above the panel body. */
  label?: string;
  /** Accent block color: mauve (default), lavender, gold, or ice. */
  tone?: LcarsPanelTone;
  children: ReactNode;
}

/**
 * LCARS sub-panel — the clipped-corner content block.
 * Presentational only: props in, markup out; no fetching, no state.
 */
export function LcarsPanel({ label, tone = 'panel', children }: LcarsPanelProps) {
  return (
    <div className={`lcars-panel lcars-panel--${tone}`}>
      {label ? <span className="lcars-panel__label">{label}</span> : null}
      <div className="lcars-panel__body">{children}</div>
    </div>
  );
}
