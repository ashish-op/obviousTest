'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const SESSION_KEY = 'sickbay.disclaimer.acknowledged.v1';

type AckState = 'unresolved' | 'acknowledged' | 'unacknowledged';

/**
 * Gates the app shell behind the clinical disclaimer until the user
 * acknowledges it once per session. Fails closed: the overlay renders until
 * acknowledgment resolves, and the session flag is written only after the
 * audit_logs row is accepted server-side — an unacknowledged session can
 * never look acknowledged.
 */
export function DisclaimerModal({ children }: { children: ReactNode }) {
  const [ackState, setAckState] = useState<AckState>('unresolved');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acknowledgeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setAckState(
      window.sessionStorage.getItem(SESSION_KEY) === '1'
        ? 'acknowledged'
        : 'unacknowledged',
    );
  }, []);

  useEffect(() => {
    if (ackState === 'unacknowledged') acknowledgeRef.current?.focus();
  }, [ackState]);

  if (ackState === 'acknowledged') return <>{children}</>;

  async function acknowledge(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/audit/disclaimer-ack', {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`audit write failed (HTTP ${response.status})`);
      }
      window.sessionStorage.setItem(SESSION_KEY, '1');
      setAckState('acknowledged');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `Acknowledgment could not be recorded: ${cause.message}`
          : 'Acknowledgment could not be recorded.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="lcars-disclaimer">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sickbay-disclaimer-title"
        className="lcars-disclaimer__card"
      >
        <h1 id="sickbay-disclaimer-title" className="lcars-disclaimer__title">
          Sickbay — clinical notice
        </h1>
        <p>
          Sickbay is an administrative tracking and advocacy tool only. It is
          not a diagnostic device: nothing here recommends, alters, or
          validates a prescription. Medication decisions belong to you and
          your licensed clinician.
        </p>
        <p>
          SMS confirmations and caregiver escalations are reminders, not
          medical advice. In an emergency, contact your clinician or local
          emergency services.
        </p>
        <div className="lcars-disclaimer__actions">
          <button
            ref={acknowledgeRef}
            type="button"
            className="lcars-button lcars-button--gold"
            disabled={pending}
            onClick={() => {
              void acknowledge();
            }}
          >
            {pending
              ? 'Recording acknowledgment…'
              : 'I understand — enter sickbay'}
          </button>
        </div>
        {error ? (
          <p role="alert" className="lcars-disclaimer__error">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
