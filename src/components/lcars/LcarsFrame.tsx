import type { ReactNode } from 'react';

export interface LcarsFrameProps {
  /** Title rendered in the frame bar. */
  topLabel?: string;
  /** Caption rendered under the body. */
  bottomLabel?: string;
  /** Which side carries the large elbow curve. */
  elbow?: 'left' | 'right';
  children: ReactNode;
}

/**
 * LCARS elbow frame — curved accent bar wrapping page or section content.
 * Presentational only: props in, markup out; no fetching, no state.
 */
export function LcarsFrame({
  topLabel,
  bottomLabel,
  elbow = 'left',
  children,
}: LcarsFrameProps) {
  return (
    <section className={`lcars-frame lcars-frame--elbow-${elbow}`}>
      <header className="lcars-frame__bar">
        <span className="lcars-frame__cap" aria-hidden="true" />
        {topLabel ? <span className="lcars-frame__title">{topLabel}</span> : null}
      </header>
      <div className="lcars-frame__body">{children}</div>
      {bottomLabel ? (
        <footer className="lcars-frame__footer">{bottomLabel}</footer>
      ) : null}
    </section>
  );
}
