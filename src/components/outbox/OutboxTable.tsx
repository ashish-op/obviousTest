import type { SmsOutboxRecord } from '@/lib/telephony/outbox';
import { StatusPill } from '@/components/lcars/StatusPill';
import './outbox.css';

/**
 * SMS outbox console table (build spec: "the demo console renders what would
 * hit a phone"). Presentational only — records arrive pre-masked from
 * listOutboxForConsole; this component never touches keys or envelopes.
 * Renders both directions and both delivery modes (fixture + real).
 */

function directionPill(record: SmsOutboxRecord): 'confirmed' | 'info' {
  return record.direction === 'outbound' ? 'confirmed' : 'info';
}

export function OutboxTable({ records }: { records: readonly SmsOutboxRecord[] }) {
  if (records.length === 0) {
    return (
      <p className="lcars-outbox__empty" data-testid="outbox-empty">
        No transmissions logged yet. Confirm a dose by texting the patient number,
        or run an escalation sweep to notify a caregiver.
      </p>
    );
  }

  return (
    <table className="lcars-outbox__table" data-testid="outbox-table">
      <thead>
        <tr>
          <th scope="col">Time (UTC)</th>
          <th scope="col">Direction</th>
          <th scope="col">Number</th>
          <th scope="col">Mode</th>
          <th scope="col">Message</th>
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr key={record.id} data-testid="outbox-row">
            <td className="lcars-outbox__time">{record.createdAt.replace('T', ' ').slice(0, 19)}</td>
            <td>
              <StatusPill status={directionPill(record)}>{record.direction}</StatusPill>
            </td>
            <td className="lcars-outbox__number">{record.maskedNumber ?? '(unreadable)'}</td>
            <td>
              <span
                className={`lcars-outbox__mode ${record.deliveryMode === 'real' ? 'lcars-outbox__mode--real' : ''}`}
              >
                {record.deliveryMode}
              </span>
            </td>
            <td className="lcars-outbox__body">{record.body}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
