import type { LabelExtractionResult } from '@/lib/adapters/types';
import type { ConfidenceGate } from '@/lib/engines/confidence-gate';
import type { RxNormMatch } from '@/lib/engines/rxnorm';

/**
 * Ingestion flow types (PRD §3, build spec task 5): photo upload → vision
 * extraction → confidence gate. Routes are thin adapters over the handlers in
 * this module; integration tests call the handlers directly with a migrated
 * database and injected adapters.
 */

/** Upper bound on images per scan batch — PRD §3 "up to 10 photos". */
export const MAX_UPLOAD_IMAGES = 10;

/** Per-image size cap: 10 MiB is ample for a phone photo of a label. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Content types the ingestion flow accepts. */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export interface UploadedPhoto {
  id: string;
  /** Filename on local blob storage (uploads dir); not the original name. */
  filename: string;
  originalName: string;
  contentType: string;
  byteSize: number;
  /** Fetchable URL for the stored blob (served by /api/ingest/files/[filename]). */
  url: string;
}

export interface UploadBatchResult {
  uploads: UploadedPhoto[];
}

export interface ExtractionSucceeded {
  imageUrl: string;
  status: 'succeeded';
  /** The confidence-gate branch — 'auto_populate' ≥ 0.70, else modal. */
  gate: ConfidenceGate;
  extraction: LabelExtractionResult;
  /** Seeded RxNorm match; null → flag for manual RXCUI entry (PRD §4). */
  rxnorm: RxNormMatch | null;
  /**
   * Canonical side effects to persist: the RxNorm seed list merged with the
   * label's own warnings (union, match first). Drives the DIZZY check-in.
   */
  highRiskSideEffects: string[];
}

export interface ExtractionFailed {
  imageUrl: string;
  status: 'failed';
  reason: string;
}

/** One image's outcome — a failed read must surface, never silently vanish. */
export type ExtractedImageOutcome = ExtractionSucceeded | ExtractionFailed;

export interface ExtractionBatchResult {
  outcomes: ExtractedImageOutcome[];
}
