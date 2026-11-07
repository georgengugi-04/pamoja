import 'dotenv/config';

// Point the application at the TEST database before any application module opens a pool.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.RESERVATION_TTL_MINUTES = '15';
