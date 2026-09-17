/**
 * Schedule API input validation. Same validator pattern as the rest of the
 * app: ApiValidationError → route maps to a plain 400.
 */

import { isRecord } from '@/lib/adapters/json';
import { ApiValidationError } from '@/lib/api/errors';
import { isHhMmClock } from './clock';

/** POST /api/schedule/shift — the new wake anchor ("Woke up late"). */
export function parseShiftInput(body: unknown): { wakeTime: string } {
  if (!isRecord(body)) {
    throw new ApiValidationError('Request body must be a JSON object.');
  }
  if (!isHhMmClock(body.wakeTime)) {
    throw new ApiValidationError('"wakeTime" is required and must be HH:MM (00:00–23:59).');
  }
  return { wakeTime: body.wakeTime };
}

/** POST /api/schedule/doses/[id] — the UI's confirm/skip actions. */
export function parseTransitionInput(body: unknown): { action: 'confirm' | 'skip' } {
  if (!isRecord(body)) {
    throw new ApiValidationError('Request body must be a JSON object.');
  }
  if (body.action !== 'confirm' && body.action !== 'skip') {
    throw new ApiValidationError('"action" must be "confirm" or "skip".');
  }
  return { action: body.action };
}
