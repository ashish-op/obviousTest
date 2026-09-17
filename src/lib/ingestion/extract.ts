import { LabelExtractionError } from '@/lib/adapters/concentrateai';
import type { Adapters } from '@/lib/adapters/types';
import {
  evaluateExtractionConfidence,
  normalizeMedicationName,
} from '@/lib/engines';
import type { SqliteDb } from '@/lib/db/connection';
import { ApiValidationError } from '@/lib/api/errors';
import {
  MAX_UPLOAD_IMAGES,
  type ExtractedImageOutcome,
  type ExtractionBatchResult,
} from './types';
import { mergeSideEffects } from './side-effects';

/**
 * Extraction handler (PRD §3): reads every uploaded label photo through the
 * injected VisionOcrAdapter, evaluates the 0.70 confidence gate per image,
 * and normalizes the generic name against the seeded RxNorm map. The route
 * builds deps from process.env (credentials present → real ConcentrateAI,
 * absent → deterministic fixtures); tests inject adapters directly.
 */
export interface ExtractionDeps {
  db: SqliteDb;
  adapters: Adapters;
}

export async function extractFromPhotos(
  deps: ExtractionDeps,
  imageUrls: string[],
): Promise<ExtractionBatchResult> {
  if (imageUrls.length === 0) {
    throw new ApiValidationError('No image URLs provided — upload photos first.');
  }
  if (imageUrls.length > MAX_UPLOAD_IMAGES) {
    throw new ApiValidationError(
      `Too many image URLs: ${imageUrls.length} provided, limit is ${MAX_UPLOAD_IMAGES}.`,
    );
  }
  for (const imageUrl of imageUrls) {
    if (typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
      throw new ApiValidationError('Every image URL must be a non-empty string.');
    }
  }

  // db rides on deps for parity with the upload handler; extraction is
  // adapter- and engine-only until upload bookkeeping lands.
  void deps.db;

  const outcomes = await Promise.all(
    imageUrls.map((imageUrl) => extractOne(deps.adapters, imageUrl)),
  );
  return { outcomes };
}

async function extractOne(adapters: Adapters, imageUrl: string): Promise<ExtractedImageOutcome> {
  let extraction;
  try {
    extraction = await adapters.visionOcr.extractLabel(imageUrl);
  } catch (cause) {
    const reason =
      cause instanceof LabelExtractionError
        ? cause.message
        : 'Label extraction failed — the adapter rejected the image.';
    return { imageUrl, status: 'failed', reason };
  }

  // A malformed confidence must surface, not silently branch: the gate throws
  // RangeError outside [0, 1], which becomes a failed outcome for that image.
  try {
    const gate = evaluateExtractionConfidence(extraction.confidence);
    const rxnorm = normalizeMedicationName(extraction.genericName);
    return {
      imageUrl,
      status: 'succeeded',
      gate,
      extraction,
      rxnorm,
      highRiskSideEffects: mergeSideEffects(extraction.highRiskSideEffects, rxnorm),
    };
  } catch (cause) {
    return {
      imageUrl,
      status: 'failed',
      reason: cause instanceof Error ? cause.message : 'Extraction confidence was malformed.',
    };
  }
}
