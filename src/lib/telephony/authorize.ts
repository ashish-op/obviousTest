/**
 * Inbound webhook authorization (build spec: "validates the X-Twilio-Signature
 * header in real mode").
 *
 * Real mode = the same credential triple that flips the SMS adapter to Twilio
 * (single source of truth: hasTwilioCredentials). In fixture mode there is no
 * auth token to verify against, so the check is a pass-through — CI and the
 * offline demo can exercise the protocol without forging capabilities being
 * relevant. In real mode an invalid OR MISSING signature is a hard reject;
 * the route maps this to HTTP 403.
 */

import { hasTwilioCredentials } from '@/lib/adapters';
import { validateTwilioSignature } from '@/lib/adapters/twilio';
import type { Env } from '@/lib/adapters/types';

export type InboundAuthorization = 'authorized' | 'unauthorized';

export function authorizeInboundSms(input: {
  env: Env;
  /** Full request URL the webhook was registered under (query included). */
  url: string;
  signature: string | null | undefined;
  /** Parsed POST form fields — Twilio's signature covers these. */
  params: Record<string, string>;
}): InboundAuthorization {
  if (!hasTwilioCredentials(input.env)) return 'authorized'; // fixture mode
  const authToken = input.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return 'unauthorized'; // unreachable given the triple check; typed guard
  return validateTwilioSignature({
    authToken,
    signature: input.signature,
    url: input.url,
    params: input.params,
  })
    ? 'authorized'
    : 'unauthorized';
}
