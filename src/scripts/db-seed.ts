import { defaultDbPath, openDatabase } from '../lib/db/connection';
import { runMigrations } from '../lib/db/migrate';
import { seedDemoProfile, DEMO_PROFILE_ID } from '../lib/db/seed';
import { loadDotEnv } from './load-dot-env';

loadDotEnv();

const db = runMigrations(openDatabase(defaultDbPath()));
const result = seedDemoProfile(db, process.env);
console.log(
  result.created
    ? `Seeded demo profile ${DEMO_PROFILE_ID} into ${defaultDbPath()}`
    : `Demo profile ${DEMO_PROFILE_ID} already present in ${defaultDbPath()} — no-op`,
);
