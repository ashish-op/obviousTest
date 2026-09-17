'use client';

import { useState } from 'react';
import { DataValue } from '@/components/lcars/DataValue';
import { StatusPill } from '@/components/lcars/StatusPill';
import type { LcarsStatus } from '@/components/lcars/StatusPill';
import type { LabelExtractionResult } from '@/lib/adapters/types';
import type { RxNormMatch } from '@/lib/engines/rxnorm';

export interface MedicationCardValues {
  brandName: string;
  genericName: string;
  dosage: string;
  instructionsRaw: string;
  rxcui: string;
  highRiskSideEffects: string[];
}

export interface MedicationCardFormProps {
  /** Pre-filled from extraction (auto or granted call) or blank (manual override). */
  initialValues: MedicationCardValues;
  /** Card caption, e.g. "AUTO-POPULATED · 0.94" or "MANUAL OVERRIDE". */
  badge: string;
  /** Pill status matching the badge semantics. */
  badgeStatus: LcarsStatus;
  saveLabel: string;
  onSave: (values: MedicationCardValues) => Promise<void>;
}

/**
 * Editable medication card (PRD §3): the extraction pre-fills every field and
 * the user corrects before saving. Presentational + local form state only —
 * persistence happens through onSave.
 */
export function MedicationCardForm({
  initialValues,
  badge,
  badgeStatus,
  saveLabel,
  onSave,
}: MedicationCardFormProps) {
  const [values, setValues] = useState<MedicationCardValues>(initialValues);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update<K extends keyof MedicationCardValues>(key: K, value: MedicationCardValues[K]) {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await onSave(values);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Saving the medication failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="lcars-panel lcars-panel--panel medication-card" aria-label={badge}>
      <header className="medication-card__header">
        <StatusPill status={badgeStatus}>{badge}</StatusPill>
        {saved ? <StatusPill status="confirmed">saved</StatusPill> : null}
      </header>
      <div className="medication-card__grid">
        <label className="medication-card__field">
          <span>Brand name</span>
          <input
            value={values.brandName}
            onChange={(event) => update('brandName', event.target.value)}
            placeholder="e.g. Synthroid"
          />
        </label>
        <label className="medication-card__field">
          <span>Generic name *</span>
          <input
            value={values.genericName}
            onChange={(event) => update('genericName', event.target.value)}
            placeholder="e.g. levothyroxine"
            required
          />
        </label>
        <label className="medication-card__field">
          <span>Dosage *</span>
          <input
            value={values.dosage}
            onChange={(event) => update('dosage', event.target.value)}
            placeholder="e.g. 50 mcg"
            required
          />
        </label>
        <label className="medication-card__field">
          <span>RXCUI (optional)</span>
          <input
            value={values.rxcui}
            onChange={(event) => update('rxcui', event.target.value)}
            placeholder="leave blank if unknown"
          />
        </label>
        <label className="medication-card__field medication-card__field--wide">
          <span>Instructions</span>
          <textarea
            value={values.instructionsRaw}
            onChange={(event) => update('instructionsRaw', event.target.value)}
            rows={2}
          />
        </label>
        <label className="medication-card__field medication-card__field--wide">
          <span>High-risk side effects (comma-separated)</span>
          <input
            value={values.highRiskSideEffects.join(', ')}
            onChange={(event) =>
              update(
                'highRiskSideEffects',
                event.target.value
                  .split(',')
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0),
              )
            }
            placeholder="e.g. dizziness, orthostasis"
          />
        </label>
      </div>
      <div className="medication-card__actions">
        <button
          type="button"
          className="lcars-button lcars-button--gold"
          onClick={handleSave}
          disabled={saving || saved || values.genericName.trim().length === 0 || values.dosage.trim().length === 0}
        >
          {saved ? 'SAVED' : saving ? 'SAVING…' : saveLabel}
        </button>
        <DataValue label="Fields editable" value="yes" />
      </div>
      {error ? (
        <p role="alert" className="medication-card__error">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** Extraction -> prefilled card values (pure mapping, exported for tests). */
export function cardValuesFromExtraction(
  extraction: LabelExtractionResult,
  rxnorm: RxNormMatch | null,
): MedicationCardValues {
  return {
    brandName: extraction.brandName,
    genericName: extraction.genericName,
    dosage: extraction.dosage,
    instructionsRaw: extraction.instructionsRaw,
    rxcui: rxnorm?.rxcui ?? extraction.rxcui ?? '',
    highRiskSideEffects: extraction.highRiskSideEffects,
  };
}

/** The blank card a MANUAL OVERRIDE opens. */
export const BLANK_CARD_VALUES: MedicationCardValues = {
  brandName: '',
  genericName: '',
  dosage: '',
  instructionsRaw: '',
  rxcui: '',
  highRiskSideEffects: [],
};
