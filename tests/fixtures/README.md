# Recorded wire-format fixtures

Hand-authored HTTP payloads matching each provider's **documented** response
schema. They are the recording medium for the real adapters' contract tests:
tests inject them through an in-memory `fetch` stub, so a CI run proves the
adapters speak the real wire format **without ever making a live call**.

- `twilio/` — Twilio REST `POST .../Messages.json` success (201) and error (400)
  bodies for `createTwilioSmsAdapter`.
- `concentrateai/` — ConcentrateAI unified Responses API replies for
  `createConcentrateAiVisionAdapter`: the `output_text` convenience form, an
  `output[].content[]` walk with markdown-fenced model text, and a 401 error.

Provenance: authored this session against the providers' documented schemas —
no live capture yet by design. The task-10 real-credential smoke replaces these
with genuinely recorded responses when the first live calls happen.

`$comment` keys are documentation and are ignored by every parser.
