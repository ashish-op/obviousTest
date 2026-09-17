'use client';

import { useCallback, useRef, useState } from 'react';
import { LcarsPanel } from '@/components/lcars/LcarsPanel';
import { StatusPill } from '@/components/lcars/StatusPill';
import {
  BLANK_CARD_VALUES,
  MedicationCardForm,
  cardValuesFromExtraction,
  type MedicationCardValues,
} from './MedicationCardForm';
import { LowConfidenceModal } from './LowConfidenceModal';
import { extractPhotos, saveMedication, uploadPhotos } from '@/lib/ingestion/api-client';
import type { ExtractedImageOutcome, UploadedPhoto } from '@/lib/ingestion/types';
import type { MedicationCreateInput } from '@/lib/medications/validation';
import type { LowConfidenceAction } from '@/lib/engines/confidence-gate';

type Phase = 'idle' | 'uploading' | 'extracting' | 'review';

interface ScanItem {
  photo: UploadedPhoto;
  outcome: ExtractedImageOutcome;
  /** Set when the low-confidence modal resolves; grants/manual render cards. */
  modalResolvedAs?: LowConfidenceAction;
  /** Medication id once the card is saved — drives the "saved" pill. */
  savedRecordId?: string;
}

const ACCEPTED = 'image/png,image/jpeg,image/webp';

/**
 * Batch scanner (PRD §3): upload up to 10 label photos, read them through the
 * vision adapter, and branch on the 0.70 confidence gate — auto-populated
 * editable cards above it, the audited low-confidence modal below it.
 */
export function BatchScanner() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ScanItem[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setItems([]);
    setError(null);
    setPhase('idle');
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  async function handleScan(): Promise<void> {
    const files = Array.from(inputRef.current?.files ?? []);
    if (files.length === 0) {
      setError('Choose between 1 and 10 label photos first.');
      return;
    }
    setError(null);
    setPhase('uploading');
    try {
      const uploads = await uploadPhotos(files);
      setPhase('extracting');
      const outcomes = await extractPhotos(uploads.map((upload) => upload.url));
      // The two services preserve order by construction; zip on index and
      // assert defensively so a contract slip can never mislabel a photo.
      setItems(
        uploads.map((photo, index) => {
          const outcome = outcomes[index];
          if (!outcome) throw new Error('Extraction response did not cover every photo.');
          return { photo, outcome };
        }),
      );
      setPhase('review');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Scanning failed.');
      setPhase('idle');
    }
  }

  function handleModalResolve(imageUrl: string) {
    return (action: LowConfidenceAction) => {
      setItems((previous) =>
        previous.map((item) =>
          item.outcome.imageUrl === imageUrl ? { ...item, modalResolvedAs: action } : item,
        ),
      );
    };
  }

  function buildSaveInput(item: ScanItem, values: MedicationCardValues): MedicationCreateInput {
    if (item.outcome.status !== 'succeeded') {
      throw new Error('A failed read has no medication to save.');
    }
    const manual = item.outcome.gate === 'low_confidence_review' && item.modalResolvedAs === 'manual_override';
    return {
      brandName: values.brandName || null,
      genericName: values.genericName,
      dosage: values.dosage,
      instructionsRaw: values.instructionsRaw,
      rxcui: values.rxcui || null,
      bufferType: null,
      minBufferMinutes: null,
      highRiskSideEffects: values.highRiskSideEffects,
      source: manual ? 'manual' : 'ocr',
      extractionConfidence: manual ? null : item.outcome.extraction.confidence,
    };
  }

  function renderOutcome(item: ScanItem): JSX.Element {
    const { outcome, photo } = item;
    if (outcome.status === 'failed') {
      return (
        <LcarsPanel key={photo.id} label={photo.url} tone="panel">
          <StatusPill status="alert">read failed</StatusPill>
          <p>{outcome.reason}</p>
        </LcarsPanel>
      );
    }

    const succeeded = outcome;
    if (succeeded.gate === 'low_confidence_review' && !item.modalResolvedAs) {
      // Modal path — render only this photo's modal; the rest of the batch
      // stays visible below the overlay.
      return (
        <LowConfidenceModal
          key={photo.id}
          imageUrl={succeeded.imageUrl}
          extraction={succeeded.extraction}
          onResolve={handleModalResolve(succeeded.imageUrl)}
        />
      );
    }

    const manual = item.modalResolvedAs === 'manual_override';
    const granted = item.modalResolvedAs === 'grant_permission_to_call';
    const badge = manual
      ? 'MANUAL OVERRIDE'
      : granted
        ? `LOW CONFIDENCE · ${succeeded.extraction.confidence.toFixed(2)} · CALL GRANTED`
        : `AUTO-POPULATED · ${succeeded.extraction.confidence.toFixed(2)}`;
    const initialValues = manual ? BLANK_CARD_VALUES : cardValuesFromExtraction(succeeded.extraction, succeeded.rxnorm);

    return (
      <MedicationCardForm
        key={photo.id}
        badge={badge}
        badgeStatus={manual || granted ? 'pending' : 'confirmed'}
        saveLabel="SAVE MEDICATION"
        initialValues={initialValues}
        onSave={async (values) => {
          const record = await saveMedication(buildSaveInput(item, values));
          setItems((previous) =>
            previous.map((candidate) =>
              candidate.photo.id === photo.id ? { ...candidate, savedRecordId: record.id } : candidate,
            ),
          );
        }}
      />
    );
  }

  const reviewing = phase === 'review';

  return (
    <div className="batch-scanner">
      <LcarsPanel label="Label photos" tone="panel">
        <p className="batch-scanner__hint">
          Choose up to 10 pill-bottle label photos (PNG, JPEG, or WebP; 10 MiB each).
        </p>
        <input ref={inputRef} type="file" accept={ACCEPTED} multiple onChange={() => setError(null)} />
        <div className="batch-scanner__controls">
          <button
            type="button"
            className="lcars-button lcars-button--lavender"
            onClick={handleScan}
            disabled={phase === 'uploading' || phase === 'extracting'}
          >
            {phase === 'uploading' ? 'UPLOADING…' : phase === 'extracting' ? 'SCANNING…' : 'SCAN LABELS'}
          </button>
          {reviewing ? (
            <button type="button" className="lcars-button" onClick={reset}>
              NEW BATCH
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="batch-scanner__error">
            {error}
          </p>
        ) : null}
      </LcarsPanel>
      {reviewing ? <div className="batch-scanner__results">{items.map(renderOutcome)}</div> : null}
    </div>
  );
}
