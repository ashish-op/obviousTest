import type { LabelExtractionResult } from '@/lib/adapters/types';
import type { MedicationCreateInput } from '@/lib/medications/validation';
import type { MedicationRecord } from '@/lib/medications/repository';
import type { ExtractedImageOutcome, UploadedPhoto } from './types';
import type { LowConfidenceAction } from '@/lib/engines/confidence-gate';

/**
 * Browser-side typed clients for the ingestion surfaces. Thin fetch wrappers
 * with one error convention: non-OK responses throw with the server's error
 * message so component state can render it, never swallow it.
 */

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function postJson<T>(url: string, body: unknown, expectedStatus: number): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== expectedStatus) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as T;
}

export async function uploadPhotos(files: File[]): Promise<UploadedPhoto[]> {
  const form = new FormData();
  for (const file of files) form.append('photos', file);
  const response = await fetch('/api/ingest/upload', { method: 'POST', body: form });
  if (response.status !== 201) {
    throw new Error(await readError(response));
  }
  const result = (await response.json()) as { uploads: UploadedPhoto[] };
  return result.uploads;
}

export async function extractPhotos(imageUrls: string[]): Promise<ExtractedImageOutcome[]> {
  const result = await postJson<{ outcomes: ExtractedImageOutcome[] }>(
    '/api/ingest/extract',
    { imageUrls },
    200,
  );
  return result.outcomes;
}

export async function saveMedication(input: MedicationCreateInput): Promise<MedicationRecord> {
  return postJson<MedicationRecord>('/api/medications', input, 201);
}

export interface LowConfidenceAuditResponse {
  ok: true;
  auditId: string;
  action: LowConfidenceAction;
}

export async function reportLowConfidenceAction(
  action: LowConfidenceAction,
  imageUrl: string | null,
): Promise<LowConfidenceAuditResponse> {
  return postJson<LowConfidenceAuditResponse>(
    '/api/audit/low-confidence-action',
    { action, imageUrl },
    201,
  );
}

export type { LabelExtractionResult };
