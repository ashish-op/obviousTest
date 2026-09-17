import { defaultDbPath, openDatabase } from '../lib/db/connection';
import { runMigrations } from '../lib/db/migrate';

const db = runMigrations(openDatabase(defaultDbPath()));
const applied = db.prepare('SELECT name FROM _migrations ORDER BY name').all() as {
  name: string;
}[];
console.log(`Migrations applied to ${defaultDbPath()}:`);
for (const { name } of applied) console.log(`  - ${name}`);
