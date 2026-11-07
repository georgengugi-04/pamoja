import { pool } from './database';
import { runMigrations, runSeed } from './migrate';

async function main(): Promise<void> {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database already up to date.');
  if (process.argv.includes('--seed')) {
    await runSeed(pool);
    console.log('Seed data applied.');
  }
}

main()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
