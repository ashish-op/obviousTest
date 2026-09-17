/**
 * Load `.env` from the repo root for the tsx CLI scripts. The Next.js server
 * loads `.env` itself, but plain `tsx` runs do not — without this the db
 * scripts would demand the full env triple by hand. Existing process.env
 * always wins (explicit env overrides the file, standard dotenv behavior).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnv(filePath = path.join(process.cwd(), '.env')): number {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return 0; // No .env — the caller's explicit env is the whole config.
  }

  let applied = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue; // Not a KEY=VALUE line — skip rather than guess.
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key in process.env) continue;
    process.env[key] = value;
    applied += 1;
  }
  return applied;
}
