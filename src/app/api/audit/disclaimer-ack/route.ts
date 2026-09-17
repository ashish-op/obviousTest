import { NextRequest, NextResponse } from 'next/server';
import { recordAuditEvent, DISCLAIMER_ACK_ACTION } from '@/lib/audit';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';

function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim() || null;
  }
  return request.headers.get('x-real-ip');
}

/**
 * Records a disclaimer acknowledgment (PRD §8 audit trail). The client only
 * ever sees success/failure — user agent and hashed IP come from the request.
 */
export async function POST(request: NextRequest) {
  const record = recordAuditEvent(getDb(), {
    action: DISCLAIMER_ACK_ACTION,
    userId: DEMO_PROFILE_ID,
    userAgent: request.headers.get('user-agent'),
    ip: clientIp(request),
  });
  return NextResponse.json({ ok: true, auditId: record.id }, { status: 201 });
}
