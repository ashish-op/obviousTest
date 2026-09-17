import type { CheckInState, SideEffectTimeline } from '@/lib/engines/red-flag-timeline';
import { StatusPill, type LcarsStatus } from '@/components/lcars/StatusPill';
import './monitoring.css';

/**
 * Side-effect monitor (build spec: "red-flag status surfaces in the UI").
 * Presentational only — the timeline arrives pre-classified from the
 * red-flag-timeline engine via the side-effect store; this component never
 * touches the database or the classification rules.
 */

const CHECK_IN_PILL: Record<CheckInState, LcarsStatus> = {
  outstanding: 'pending',
  clean: 'confirmed',
  red_flag: 'alert',
};

const CHECK_IN_LABEL: Record<CheckInState, string> = {
  outstanding: 'check-in outstanding',
  clean: 'check-in clean',
  red_flag: 'red flag',
};

function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

export function SideEffectMonitor({ timeline }: { timeline: SideEffectTimeline }) {
  return (
    <section aria-label="Side-effect monitoring">
      <div className="lcars-monitor__summary">
        <span className="lcars-monitor__headline" data-testid="red-flag-summary">
          {timeline.hasRedFlags
            ? `${timeline.redFlagCount} red flag${timeline.redFlagCount === 1 ? '' : 's'} for physician review`
            : 'No red flags — all check-ins clean or outstanding'}
        </span>
      </div>
      {timeline.entries.length === 0 ? (
        <p className="lcars-monitor__empty" data-testid="monitoring-empty">
          No doses on the schedule yet. Add medications on the scanner page —
          check-in state appears here as doses are confirmed by SMS.
        </p>
      ) : (
        <table className="lcars-monitor__table" data-testid="monitoring-table">
          <thead>
            <tr>
              <th scope="col">Scheduled (UTC)</th>
              <th scope="col">Medication</th>
              <th scope="col">Check-in</th>
              <th scope="col">Severity</th>
              <th scope="col">Reconciliation</th>
            </tr>
          </thead>
          <tbody>
            {timeline.entries.map((entry) => (
              <tr
                key={entry.scheduleId}
                data-testid={entry.isRedFlag ? 'red-flag-row' : 'monitoring-row'}
                className={entry.isRedFlag ? 'lcars-monitor__row--flagged' : undefined}
              >
                <td className="lcars-monitor__time">{formatTime(entry.scheduledFor)}</td>
                <td className="lcars-monitor__medication">{entry.medicationName}</td>
                <td>
                  {entry.checkInState === null ? (
                    <span className="lcars-monitor__no-checkin">—</span>
                  ) : (
                    <StatusPill status={CHECK_IN_PILL[entry.checkInState]}>
                      {CHECK_IN_LABEL[entry.checkInState]}
                    </StatusPill>
                  )}
                </td>
                <td className="lcars-monitor__severity">
                  {entry.logs.map((log) => `${log.severity}/5`).join(', ') || '—'}
                </td>
                <td className="lcars-monitor__prompt">
                  {entry.logs
                    .filter((log) => log.isRedFlag)
                    .map((log) => log.reconciliationPrompt)
                    .join(' ') || (entry.checkInState === 'outstanding' ? 'Awaiting patient reply.' : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="lcars-monitor__footnote">
        Reported symptoms are logged for your physician&apos;s review — Sickbay
        never adjusts a prescription.
      </p>
    </section>
  );
}
