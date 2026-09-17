# AGENTS.md — Sickbay Polypharmacy Engine

Build spec: Obvious artifact `art_GJnhfsve` (pinned). PRD §2 DDL parity is the
persistence contract; the canonical DDL lives at `docs/prd-ddl.sql` and is
pinned by `tests/schema-parity.test.ts` — do not edit either without updating both.

## Commands

```bash
npm run build        # next build (also typechecks)
npm run lint         # next lint
npm test             # vitest run (CI gate — must pass with zero external services)
npm run db:init      # migrate + seed local SQLite (data/sickbay.db, gitignored)
npm run dev
```

## Conventions

- **Engines are pure functions** under `src/lib/engines/` — no I/O, fully unit-tested.
- **Integrations live behind adapters** under `src/lib/adapters/` selected by an
  env-based factory: credentials present → real Twilio/ConcentrateAI; absent →
  deterministic fixtures. CI never has credentials and can never reach a real service.
- **Persistence** is better-sqlite3 (sync, no ORM). Migrations are numbered SQL
  files under `src/lib/db/migrations/`, applied in order and tracked in
  `_migrations`. Enums are CHECK constraints (SQLite); keep them identical to the
  Supabase/Postgres contract so migration is a lift, not a rewrite.
- **Phone numbers are encrypted at rest** (AES-256-GCM, `PHONE_ENCRYPTION_KEY`
  env, 32 bytes). Never store a raw phone number; never commit `.env`.
- **Scope invariant**: administrative tracking/advocacy only — nothing recommends,
  alters, or validates a prescription. Every user surface carries the clinical disclaimer.
- TypeScript strict; no `any`. New logic gets a named function and a test.

## CI

GitHub Actions runs lint + typecheck + build + tests with no secrets. Any test
requiring network or credentials must be a fixture-backed test instead.
