import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDb } from '@/lib/db/connection';

export const DISCLAIMER_ACK_ACTION = 'disclaimer_acknowledged';
export const RECONCILIATION_PDF_EXPORT_ACTION = 'reconciliation_pdf_exported';

export interface AuditEventInput {
  action: string;
  userId?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  details?: string | null;
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
}

/** SHA-256 of the raw IP — PRD §8 requires hashed IPs in audit_logs. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip, 'utf8').digest('hex');
}

/**
 * Appends one audit_logs row. Pure persistence: caller owns the DB handle
 * and every field's provenance (request headers, session, etc.).
 */
export function recordAuditEvent(
  db: SqliteDb,
  input: AuditEventInput,
): AuditEventRecord {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO audit_logs (id, user_id, action, user_agent, hashed_ip, details) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    input.userId ?? null,
    input.action,
    input.userAgent ?? null,
    input.ip ? hashIp(input.ip) : null,
    input.details ?? null,
  );
  return { ...input, id };
}
