/**
 * GET /api/reconciliation/pdf — physician advocacy report export (PRD §7).
 *
 * Renders server-side from the current schedule + side-effect logs and
 * returns the PDF as a download. Every export writes an audit_logs row
 * (PRD §8 audit trail). Backed by the seeded demo profile this iteration.
 */

import type { NextRequest } from 'next/server';
import { RECONCILIATION_PDF_EXPORT_ACTION, recordAuditEvent } from '@/lib/audit';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { renderReconciliationPdf } from '@/lib/reconciliation/render';
import { loadReconciliationPdfData } from '@/lib/reconciliation/store';

// Rendering hits SQLite and the clock — never prerender at build time.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const db = getDb();
  const generatedAt = new Date().toISOString();
  const data = loadReconciliationPdfData(db, DEMO_PROFILE_ID, generatedAt);
  const pdf = await renderReconciliationPdf(data);

  recordAuditEvent(db, {
    action: RECONCILIATION_PDF_EXPORT_ACTION,
    userId: DEMO_PROFILE_ID,
    userAgent: request.headers.get('user-agent'),
    details: `generatedAt=${generatedAt} redFlags=${data.timeline.redFlagCount}`,
  });

  // BodyInit wants a standalone ArrayBufferView, not a Buffer view over a pool.
  const bytes = new Uint8Array(pdf.byteLength);
  bytes.set(pdf);

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="reconciliation-report-${generatedAt.slice(0, 10)}.pdf"`,
      'Content-Length': String(pdf.byteLength),
    },
  });
}
