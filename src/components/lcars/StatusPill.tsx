import type { ReactNode } from 'react';

export type LcarsStatus = 'pending' | 'confirmed' | 'alert' | 'info';

/** Status -> modifier class. Pure mapping, exported for tests. */
export function statusPillClass(status: LcarsStatus): string {
  return `lcars-status-pill--${status}`;
}

export interface StatusPillProps {
  status: LcarsStatus;
  /** Pill text; defaults to the status name. */
  children?: ReactNode;
}

/**
 * LCARS status pill — gold for pending, red for alert (PRD §6 pairing).
 * Presentational only: props in, markup out; no fetching, no state.
 */
export function StatusPill({ status, children }: StatusPillProps) {
  return (
    <span className={`lcars-status-pill ${statusPillClass(status)}`}>
      {children ?? status}
    </span>
  );
}
