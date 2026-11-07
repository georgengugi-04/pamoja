import 'dotenv/config';
import { createApp } from './app';
import { pool } from './config/database';
import { processExpiredReservations } from './modules/reservations/reservation.service';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`pamoja-stock-reservation listening on http://localhost:${port}`);
});

// Optional local sweeper (disabled by default). Expiry can also be triggered via
// POST /api/reservations/process-expired.
const sweepSeconds = Number(process.env.EXPIRY_SWEEP_INTERVAL_SECONDS ?? 0);
let timer: NodeJS.Timeout | undefined;
if (sweepSeconds > 0) {
  timer = setInterval(() => {
    processExpiredReservations()
      .then((r) => r.expiredCount && console.log(`expiry sweep released ${r.expiredCount} reservation(s)`))
      .catch((err) => console.error('expiry sweep failed:', err.message));
  }, sweepSeconds * 1000);
}

async function shutdown(): Promise<void> {
  if (timer) clearInterval(timer);
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
