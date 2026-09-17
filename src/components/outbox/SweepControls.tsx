'use client';

import { useState } from 'react';

/**
 * Sweep trigger for the outbox console — POSTs one escalation tick and
 * surfaces the returned counters. The clock is injected server-side; the
 * client only pulls the trigger.
 */

interface SweepResponse {
  ok: boolean;
  outcome?: {
    backfilledJobs: number;
    dispatchedJobs: number;
    cancelledJobs: number;
  };
}

export function SweepControls() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSweep() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/telephony/sweep', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`sweep failed with status ${response.status}`);
      }
      const payload: SweepResponse = await response.json();
      const outcome = payload.outcome;
      setResult(
        outcome
          ? `Sweep complete — ${outcome.dispatchedJobs} dispatched, ${outcome.cancelledJobs} cancelled, ${outcome.backfilledJobs} backfilled`
          : 'Sweep complete',
      );
    } catch (cause) {
      // Surface the failure; never swallow it (the console must show sweep errors).
      setError(cause instanceof Error ? cause.message : 'sweep failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={runSweep} disabled={running} data-testid="sweep-button">
        {running ? 'Running sweep…' : 'Run escalation sweep'}
      </button>
      {result ? (
        <p className="lcars-outbox__sweep-result" data-testid="sweep-result">
          {result}
        </p>
      ) : null}
      {error ? (
        <p className="lcars-outbox__sweep-result" data-testid="sweep-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
