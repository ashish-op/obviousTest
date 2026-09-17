'use client';

import { useEffect, useRef, useState } from 'react';
import { LcarsPanel } from '@/components/lcars/LcarsPanel';
import { StatusPill } from '@/components/lcars/StatusPill';
import { DataValue } from '@/components/lcars/DataValue';
import { reportLowConfidenceAction } from '@/lib/ingestion/api-client';
import type { LowConfidenceAction } from '@/lib/engines/confidence-gate';
import type { LabelExtractionResult } from '@/lib/adapters/types';

export interface LowConfidenceModalProps {
  /** Stored photo URL for the weak read — recorded in the audit row. */
  imageUrl: string;
  extraction: LabelExtractionResult;
  /** Resolves the modal after the audit row is accepted server-side. */
  onResolve: (action: LowConfidenceAction) => void;
}

const ACTION_BUTTONS: ReadonlyArray<{ action: LowConfidenceAction; label: string; className: string }> = [
  {
    action: 'grant_permission_to_call',
    label: 'GRANT PERMISSION TO CALL',
    className: 'lcars-button lcars-button--gold',
  },
  {
    action: 'retake_photo',
    label: 'RE-TAKE PHOTO',
    className: 'lcars-button lcars-button--lavender',
  },
  {
    action: 'manual_override',
    label: 'MANUAL OVERRIDE',
    className: 'lcars-button lcars-button--alert',
  },
];

/**
 * Low-confidence modal (PRD §3): opened when a label read scores below the
 * 0.70 gate. Every button writes its audit_logs row first — the modal stays
 * open on an audit failure (fail-closed, mirroring the disclaimer gate) — and
 * only then resolves so the UI can advance down the chosen path.
 */
export function LowConfidenceModal({ imageUrl, extraction, onResolve }: LowConfidenceModalProps) {
  const [pending, setPending] = useState<LowConfidenceAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolveRef = useRef(onResolve);
  resolveRef.current = onResolve;

  useEffect(() => {
    // Focus the first action so keyboard users land on the decision.
    document.querySelector<HTMLButtonElement>('.low-confidence-modal button')?.focus();
  }, []);

  async function choose(action: LowConfidenceAction): Promise<void> {
    setPending(action);
    setError(null);
    try {
      // Audit first: the trail is written even if the user closes the tab next.
      await reportLowConfidenceAction(action, imageUrl);
      resolveRef.current(action);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `The action could not be recorded: ${cause.message}`
          : 'The action could not be recorded.',
      );
      setPending(null);
    }
  }

  return (
    <div className="low-confidence-modal" role="dialog" aria-modal="true" aria-label="Low confidence read">
      <div className="low-confidence-modal__surface">
        <LcarsPanel label="Low confidence read" tone="gold">
          <p>
            The photo could not be read with confidence. Verify the label before the
            medication enters the schedule.
          </p>
          <div className="low-confidence-modal__readout">
            <DataValue label="Confidence" value={extraction.confidence.toFixed(2)} unit="of 1.00" />
            <DataValue label="Read generic" value={extraction.genericName || '—'} />
            <StatusPill status="alert">below 0.70 gate</StatusPill>
          </div>
          <div className="low-confidence-modal__actions">
            {ACTION_BUTTONS.map(({ action, label, className }) => (
              <button
                key={action}
                type="button"
                className={className}
                disabled={pending !== null}
                onClick={() => choose(action)}
              >
                {pending === action ? 'RECORDING…' : label}
              </button>
            ))}
          </div>
          {error ? (
            <p role="alert" className="low-confidence-modal__error">
              {error}
            </p>
          ) : null}
        </LcarsPanel>
      </div>
    </div>
  );
}
