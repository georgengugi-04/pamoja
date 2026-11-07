import 'dotenv/config';
import { Pool, PoolClient } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and adjust it.');
}

export const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX ?? 10),
});

export type Queryable = Pick<PoolClient, 'query'>;

/**
 * Runs `fn` inside a single PostgreSQL transaction (default READ COMMITTED).
 * Commits on success, rolls back on any thrown error, always releases the client.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken; original error matters more */
    }
    throw err;
  } finally {
    client.release();
  }
}
