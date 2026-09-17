import { isRecord } from '@/lib/adapters/json';
import { ApiValidationError } from '@/lib/api/errors';

/**
 * Medication input validation (PRD §2 `medications` contract). Fields the
 * DDL types as nullable stay optional here; everything required by the DDL
 * is required here. One validator class so routes map it to 400 uniformly.
 */

/** Fields editable on a medication card, OCR-populated or hand-entered. */
export interface MedicationCoreFields {
  brandName: string | null;
  genericName: string;
  dosage: string;
  instructionsRaw: string;
  rxcui: string | null;
}

export interface MedicationCreateInput extends MedicationCoreFields {
  highRiskSideEffects: string[];
  source: 'ocr' | 'manual';
  /** Present when source='ocr' (the gate score); null for manual entries. */
  extractionConfidence: number | null;
  /** Absorption/interaction timing metadata, usually derived from RxNorm pairs. */
  bufferType: 'absorption' | 'interaction' | null;
  minBufferMinutes: number | null;
}

export interface MedicationUpdateInput extends MedicationCoreFields {}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiValidationError(`"${field}" is required and must be non-empty.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value.trim();
}

/** The DDL CHECK constraint: buffer_type IN ('absorption', 'interaction') or NULL. */
function optionalBufferType(value: unknown): 'absorption' | 'interaction' | null {
  if (value === null || value === undefined) return null;
  if (value === 'absorption' || value === 'interaction') return value;
  throw new ApiValidationError('"bufferType" must be "absorption", "interaction", or null.');
}

/** The DDL CHECK constraint: min_buffer_minutes >= 0 or NULL. */
function optionalMinBufferMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiValidationError('"minBufferMinutes" must be a non-negative integer or null.');
  }
  return value;
}

/** The DDL CHECK constraint: extraction_confidence in [0, 1] or NULL. */
function optionalExtractionConfidence(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ApiValidationError('"extractionConfidence" must be within [0, 1] or null.');
  }
  return value;
}

/** The DDL CHECK constraint: source IN ('ocr', 'manual'). */
function requireSource(value: unknown): 'ocr' | 'manual' {
  if (value === 'ocr' || value === 'manual') return value;
  throw new ApiValidationError('"source" must be "ocr" or "manual".');
}

function requireSideEffectList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ApiValidationError('"highRiskSideEffects" must be an array of strings.');
  }
  return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Parse the editable core fields shared by create and full-replace update.
 * Throws ApiValidationError with a single clear message on the first
 * invalid field.
 */
export function parseMedicationCoreFields(body: unknown): MedicationCoreFields {
  if (!isRecord(body)) {
    throw new ApiValidationError('Request body must be a JSON object.');
  }
  return {
    brandName: optionalString(body.brandName, 'brandName'),
    genericName: requireNonEmptyString(body.genericName, 'genericName'),
    dosage: requireNonEmptyString(body.dosage, 'dosage'),
    instructionsRaw: requireNonEmptyString(body.instructionsRaw, 'instructionsRaw'),
    rxcui: optionalString(body.rxcui, 'rxcui'),
  };
}

/** Parse a POST /api/medications body (medication card save, OCR or manual). */
export function parseMedicationCreateInput(body: unknown): MedicationCreateInput {
  if (!isRecord(body)) {
    throw new ApiValidationError('Request body must be a JSON object.');
  }
  return {
    ...parseMedicationCoreFields(body),
    highRiskSideEffects: requireSideEffectList(body.highRiskSideEffects),
    source: requireSource(body.source),
    extractionConfidence: optionalExtractionConfidence(body.extractionConfidence),
    bufferType: optionalBufferType(body.bufferType),
    minBufferMinutes: optionalMinBufferMinutes(body.minBufferMinutes),
  };
}
