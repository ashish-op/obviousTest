import type { SqliteDb } from '@/lib/db/connection';
import { recordAuditEvent } from '@/lib/audit';
import { isLowConfidenceAction, type LowConfidenceAction } from '@/lib/engines/confidence-gate';
import { isRecord } from '@/lib/adapters/json';
import { ApiValidationError } from '@/lib/api/errors';

/**
 * Audit writer for the PRD §3 low-confidence modal. Every modal action —
 * GRANT PERMISSION TO CALL / RE-TAKE PHOTO / MANUAL OVERRIDE — must land in
 * audit_logs before the UI advances; the action constants are the engine's
 * `audit_logs.action` values, so the strings live in exactly one place.
 */

export interface LowConfidenceActionInput {
  action: LowConfidenceAction;
  imageUrl: string | null;
}

export interface RecordedLowConfidenceAction {
  auditId: string;
  action: LowConfidenceAction;
}

/**
 * Validates and records one modal action. Throws IngestionValidationError for
 * anything that is not one of the three engine actions — an unknown action
 * must be rejected, not recorded.
 */
export function recordLowConfidenceAction(
  db: SqliteDb,
  body: unknown,
  requestMeta: { userId: string; userAgent: string | null; ip: string | null },
): RecordedLowConfidenceAction {
  if (!isRecord(body)) {
    throw new ApiValidationError('Request body must be a JSON object.');
  }
  const { action, imageUrl } = body;
  if (typeof action !== 'string' || !isLowConfidenceAction(action)) {
    throw new ApiValidationError(
      'Unknown low-confidence action — use grant_permission_to_call, retake_photo, or manual_override.',
    );
  }
  if (imageUrl !== null && imageUrl !== undefined && typeof imageUrl !== 'string') {
    throw new ApiValidationError('imageUrl must be a string or null.');
  }

  const record = recordAuditEvent(db, {
    action,
    userId: requestMeta.userId,
    userAgent: requestMeta.userAgent,
    ip: requestMeta.ip,
    details: JSON.stringify({ imageUrl: imageUrl ?? null }),
  });
  return { auditId: record.id, action };
}
