/**
 * Server-side PDF rendering (PRD §7: "Rendered server-side from the current
 * schedule + logs"). Kept separate from the document component so engines,
 * store, and tests can share one render entry point.
 */

import { renderToBuffer } from '@react-pdf/renderer';
import type { ReconciliationPdfData } from './data';
import { ReconciliationReportDocument } from './pdf-document';

/** Render the report to PDF bytes. Helvetica only — no network font fetch. */
export async function renderReconciliationPdf(data: ReconciliationPdfData): Promise<Buffer> {
  // Called directly, not via createElement: renderToBuffer types its input as
  // ReactElement<DocumentProps>, and the document component returns precisely
  // that element (server-side render — React's reconciler never runs).
  return renderToBuffer(ReconciliationReportDocument({ data }));
}
