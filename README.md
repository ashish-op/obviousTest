# Sickbay Polypharmacy Engine

A Voyager LCARS-themed web platform that turns uncoordinated multi-drug regimens into a
buffer-aware daily schedule with two-way SMS adherence, caregiver escalation, and physician
reconciliation reporting. Real Twilio SMS and ConcentrateAI-backed label extraction, env-gated
with deterministic fixture fallbacks for CI and offline demo. Persistence stays local this
iteration.

> **Scope boundary:** this is an administrative tracking and advocacy tool, not a diagnostic
> device. Every surface carries the clinical disclaimer; nothing in the system recommends,
> alters, or validates a prescription — it flags, logs, and routes to licensed clinicians.

## Stack

- Next.js 14 (App Router) + TypeScript
- SQLite persistence (Supabase-shaped DDL; one seeded demo profile)
- Env-gated adapters: real Twilio / ConcentrateAI when credentials are present, deterministic
  fixtures otherwise (CI never reaches a live service)
- Pure domain engines under `src/lib/engines/` (schedule solver, confidence gate, escalation,
  RxNorm normalization, risk matrix)
- Vitest for all automated checks

## Quick start

```bash
npm ci

# 1. Configure the environment (see ".env" below)
cp .env.example .env   # then fill in what you have

# 2. Initialize + seed the local SQLite database
npm run db:init

# 3. Run the dev server
npm run dev            # http://localhost:3000
```

Automated verification (what CI runs — credential-free, fixtures only):

```bash
npx tsc --noEmit && npx eslint src tests && npx vitest run
npm run build
```

## Environment

`.env` is gitignored and never committed. With no credentials the app runs entirely on
deterministic fixtures; with credentials present the same adapter factory resolves to the real
services. Required pieces:

| Variable | Purpose |
| --- | --- |
| `SICKBAY_DB_PATH` | SQLite file path (`./data/sickbay.db`) |
| `PHONE_ENCRYPTION_KEY` | AES-256-GCM key; phone numbers are encrypted at rest |
| `DEMO_PROFILE_FULL_NAME` / `DEMO_PROFILE_PHONE` | Seeded demo patient (name + E.164 phone) |
| `DEMO_CAREGIVER_NAME` / `DEMO_CAREGIVER_PHONE` | Seeded demo caregiver (name + E.164 phone) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Real SMS when all three are set; `TWILIO_FROM_NUMBER` is the **sender** |
| `CONCENTRATEAI_API_KEY` / `CONCENTRATEAI_BASE_URL` / `CONCENTRATEAI_VISION_MODEL` | Real vision/LLM label extraction when set |
| `SICKBAY_PUBLIC_BASE_URL` | Optional public origin override (see "Behind a proxy" below) |

The demo `DEMO_*` phones should be numbers you control — the smoke test sends **real SMS** to
them. The demo seeds both patient and caregiver with the same Twilio-verified test destination so
every SMS leg is deliverable; change them to your own numbers.

### Behind a proxy (preview tunnels, reverse proxies)

Two features care about the PUBLIC URL, not the internal one:

- Twilio signs the inbound webhook with the public https URL, while `request.url` behind a proxy
  keeps the internal scheme/host. Signature validation reconstructs the public URL from
  `SICKBAY_PUBLIC_BASE_URL` (explicit override wins), then `x-forwarded-host`/`x-forwarded-proto`,
  then `request.url`.
- Real extraction forwards the uploaded photo's URL to the vision provider, so upload URLs must be
  publicly fetchable — served from the public origin.

When fronting the demo with a tunnel, set `SICKBAY_PUBLIC_BASE_URL` to the public https origin so
both agree with it.

## Two-way SMS wiring

With real credentials, point your Twilio messaging number's webhook for inbound messages at:

```
POST <public-origin>/api/telephony/sms-inbound
```

The handler verifies the `X-Twilio-Signature` header before touching any state (in fixture mode —
no credentials — the signature step passes through, which is what lets CI exercise the protocol).

Inbound protocol (PRD §5): `1` / `YES` / `CONFIRMED` confirm the earliest pending dose;
`DIZZY YES` / `DIZZY NO` answer the side-effect check-in for a confirmed dose flagged for
dizziness. An unconfirmed dose past 45 minutes escalates to the caregiver via the sweep below.

## Escalation sweep

Escalations are durable `escalation_jobs` rows dispatched by a fixed-interval sweep — no sleeping
processes. For the demo, trigger it manually:

```bash
curl -X POST http://localhost:3000/api/telephony/sweep
```

## Live E2E smoke test

`npm run smoke:e2e -- <public-base-url>` drives the full loop with REAL credentials against a
running server: photo upload → real ConcentrateAI extraction → medication creation → schedule
regeneration + wake shift → signed inbound confirmations → `DIZZY YES` → escalation sweep → real
caregiver SMS → reconciliation PDF → SQLite + Twilio API delivery verification. It refuses to run
without the Twilio/ConcentrateAI credential triple.

Setup it expects:

1. `.env` filled with real credentials and demo phones (numbers you control).
2. Two bottle-label photos at `scripts/fixtures/real-bottle/tylenol.jpg` and
   `scripts/fixtures/real-bottle/walgreens.jpg` (not committed — place your own; the demo photos
   used in validation were public Wikimedia Commons images: a legible Tylenol close-up and a
   prescription-style Walgreens label with patient info redacted).
3. The dev server reachable at the public URL you pass (real extraction fetches the photos from
   there, and Twilio signs webhooks against it).

Every outbound message lands in the `sms_outbox` table (both modes), so the demo console renders
exactly what would hit a phone.

### Live validation results (2026-09-17, real credentials)

- **Real extraction (the spec's flagged first pass):** both photos extracted at confidence
  **0.95** — the Tylenol photo read `Acetaminophen, 500 mg` (matches ground truth) and the
  Walgreens label read `Warfarin Sodium, 5 MG`. Caveat: the Walgreens photo is low-resolution
  (188×377); the read matched its drug field, but photo quality directly bounds extraction
  quality. Both reads auto-populated past the 0.70 gate. Neither matched the seeded RxNorm map,
  so both were flagged for manual RxNorm entry — the designed behavior for unseeded drugs.
- **Signed inbound loop:** confirmations and `DIZZY YES` processed with real signature
  validation; the unsigned request was rejected with 403.
- **Real caregiver SMS:** six outbound messages (three confirmations with the dizziness
  check-in, caregiver dizziness notice, patient thank-you, and one escalation) all carried Twilio
  message SIDs and were accepted by the Twilio API. Statuses poll as `queued`/`undelivered`
  immediately after send and settle to `delivered`/`failed` asynchronously — the smoke asserts a
  successful status fetch, not delivery.
- **Buffer solver:** the wake shift (07:00 → 09:30) held the levothyroxine/calcium pair at
  exactly 120 minutes, forward-only.
- **PDF:** reconciliation export rendered all four sections with the clinical notice.

## Known limitations

- **Persistence is local** — SQLite under the PRD's Supabase-shaped DDL; auth/RLS deferred to the
  real-storage phase (signed photo URLs are part of that phase).
- **Real-mode inbound failures surface as 500s.** If Twilio rejects a reply send (e.g. a message
  from an unregistered/invalid number), the route returns 500 so Twilio retries. Dose state is
  written before the reply send, and dedupe keys prevent double-processing.
- **Message statuses are point-in-time.** The smoke polls Twilio right after sending; final
  delivery is asynchronous by design.
- **The 0.70 confidence threshold is a PRD constant, not clinically validated** — it ships as a
  named constant so it is easy to tune later.
- **Escalation latency equals the sweep interval** in the demo; a production job runner is the
  designated future seam.

## Clinical safety

The disclaimer modal gates the app until acknowledged (once per session, audited). The system
never recommends, alters, or validates a prescription — it tracks, flags, and routes to licensed
clinicians. Side-effect reports accumulate into the physician advocacy PDF for medication
reconciliation.
