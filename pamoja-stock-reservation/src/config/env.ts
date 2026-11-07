import 'dotenv/config';

/** Read at call time so tests can override environment values. */
export function reservationTtlMinutes(): number {
  const raw = process.env.RESERVATION_TTL_MINUTES;
  if (raw === undefined || raw === '') return 15; // prototype assumption, not approved business policy
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('RESERVATION_TTL_MINUTES must be a positive number');
  }
  return n;
}
