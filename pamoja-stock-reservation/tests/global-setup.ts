import 'dotenv/config';
import { Pool } from 'pg';
import { runMigrations } from '../src/config/migrate';

/** Runs once before the suite: migrate the TEST database and start from empty tables. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env (and start PostgreSQL).');
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await runMigrations(pool);
    await pool.query('TRUNCATE reservation_events, reservations, listings RESTART IDENTITY CASCADE');
  } finally {
    await pool.end();
  }
}
