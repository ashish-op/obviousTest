import { NextRequest, NextResponse } from 'next/server';
import { ApiValidationError } from '@/lib/api/errors';
import { transitionDose } from '@/lib/schedules/repository';
import { parseTransitionInput } from '@/lib/schedules/validation';
import { getDb } from '@/lib/db/connection';
import { DEMO_PROFILE_ID } from '@/lib/db/seed';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

/**
 * POST /api/schedule/doses/[id] — the UI's confirm/skip. Same dose
 * lifecycle as the SMS loop; pending escalations for the dose are cancelled
 * on resolve.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  try {
    const input = parseTransitionInput(body);
    const outcome = transitionDose(getDb(), DEMO_PROFILE_ID, params.id, input.action, new Date());

    switch (outcome.kind) {
      case 'resolved':
        return NextResponse.json({ ok: true, dose: outcome.dose }, { status: 200 });
      case 'not_found':
        return NextResponse.json({ error: 'Dose not found.' }, { status: 404 });
      case 'not_transitionable':
        return NextResponse.json(
          {
            error: `Dose is ${outcome.current} and can no longer be ${input.action === 'confirm' ? 'confirmed' : 'skipped'}.`,
          },
          { status: 409 },
        );
    }
  } catch (cause) {
    if (cause instanceof ApiValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }
}
