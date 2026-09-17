import { NextRequest, NextResponse } from 'next/server';
import { getAdapters } from '@/lib/adapters';
import { loadEncryptionKey } from '@/lib/crypto/phone-crypto';
import { getDb } from '@/lib/db/connection';
import { authorizeInboundSms } from '@/lib/telephony/authorize';
import { handleInboundSms } from '@/lib/telephony/handle-inbound-sms';

/**
 * Two-way SMS inbound webhook (PRD §5, build spec "Two-way SMS loop").
 *
 * Twilio POSTs form-encoded bodies here. In real mode (Twilio credentials
 * present) the X-Twilio-Signature header is verified against the full request
 * URL and POST params — invalid or missing means 403 before any state is
 * touched. In fixture mode (no credentials — CI, offline demo) there is no
 * auth token to check against, so the signature step passes through.
 *
 * Protocol cases (unknown sender, no pending dose, unrecognized text) are
 * 200 outcomes — only malformed requests and bad signatures are 4xx.
 */

function formParams(form: FormData): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') params[name] = value;
  }
  return params;
}

export async function POST(request: NextRequest) {
  let params: Record<string, string>;
  try {
    params = formParams(await request.formData());
  } catch {
    // Twilio always sends a form body; anything else is a malformed request.
    return NextResponse.json({ ok: false, error: 'expected a form-encoded body' }, { status: 400 });
  }

  // Signature check BEFORE any database work — an unauthorized request never
  // opens the store. Twilio signs the URL IT was configured with — the public
  // origin. Behind a re-writing proxy, request.url keeps the internal
  // scheme/host, so reconstruct the public validation URL: an explicit
  // SICKBAY_PUBLIC_BASE_URL wins, then standard forwarding headers, then the
  // request URL as-is.
  const validationUrl = new URL(request.url);
  if (process.env.SICKBAY_PUBLIC_BASE_URL) {
    const publicBase = new URL(process.env.SICKBAY_PUBLIC_BASE_URL);
    // Assign hostname/port separately — the WHATWG URL host setter keeps an
    // existing port (localhost:3000 → e2b.app:3000) when the assigned value
    // carries none, which silently breaks signature validation.
    validationUrl.protocol = publicBase.protocol;
    validationUrl.hostname = publicBase.hostname;
    validationUrl.port = publicBase.port;
  } else {
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0];
    if (forwardedHost) {
      const forwarded = new URL(`//${forwardedHost}`, 'http://placeholder.invalid');
      validationUrl.hostname = forwarded.hostname;
      validationUrl.port = forwarded.port;
    }
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0];
    if (forwardedProto) validationUrl.protocol = forwardedProto;
  }
  const authorization = authorizeInboundSms({
    env: process.env,
    url: validationUrl.toString(),
    signature: request.headers.get('x-twilio-signature'),
    params,
  });
  if (authorization === 'unauthorized') {
    return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 403 });
  }

  const from = params.From ?? '';
  if (!from) {
    return NextResponse.json({ ok: false, error: 'missing From parameter' }, { status: 400 });
  }

  const db = getDb();
  const adapters = getAdapters(process.env, { db });
  const outcome = await handleInboundSms(
    { db, env: process.env, adapters, key: loadEncryptionKey(process.env), now: () => new Date() },
    { from, body: params.Body ?? '', providerMessageId: params.MessageSid ?? null },
  );

  // Every protocol outcome is a 200 — Twilio retries on error codes, and a
  // confused patient must never trigger a webhook retry loop.
  return NextResponse.json({ ok: true, outcome }, { status: 200 });
}
