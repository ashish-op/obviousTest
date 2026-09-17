import { NextRequest, NextResponse } from 'next/server';
import { ApiValidationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';
import { recordLowConfidenceAction } from '@/lib/ingestion/low-confidence';

export const runtime = 'nodejs';

function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim() || null;
  }
  return request.headers.get('x-real-ip');
}

/**
 * POST /api/audit/low-confidence-action — body { action, imageUrl? }.
 * Records one PRD §3 low-confidence modal action in audit_logs. The action
 * must be one of the engine's three constants; an unknown action is a 400,
 * never a silent row. Runs before the UI advances so the audit trail cannot
 * be skipped.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  try {
    const record = recordLowConfidenceAction(getDb(), body, {
      userId: DEMO_PROFILE_ID,
      userAgent: request.headers.get('user-agent'),
      ip: clientIp(request),
    });
    return NextResponse.json({ ok: true, ...record }, { status: 201 });
  } catch (cause) {
    if (cause instanceof ApiValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }
}
