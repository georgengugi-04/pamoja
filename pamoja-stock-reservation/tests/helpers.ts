import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/config/database';

export const app = createApp();
export { pool, request };

/** Unique, repeatable-test-safe references (the DB is never wiped between tests). */
export const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export async function makeListing(totalStock: number, prefix = 'PART') {
  const listingReference = uniq(prefix);
  const res = await request(app).post('/api/listings').send({ listingReference, totalStock });
  if (res.status !== 201) throw new Error(`listing setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return listingReference;
}

export function reservationBody(listingReference: string, quantity: number, over: Record<string, unknown> = {}) {
  return {
    listingReference,
    quantity,
    buyerReference: uniq('BUYER'),
    orderReference: uniq('ORDER'),
    idempotencyKey: uniq('key'),
    ...over,
  };
}

export const reserve = (body: Record<string, unknown>) => request(app).post('/api/reservations').send(body);

export async function stockOf(listingReference: string) {
  const r = await pool.query(
    `SELECT l.total_stock, l.available_stock,
            COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'ACTIVE'), 0)::int AS active_reserved,
            COUNT(r.id)::int AS reservations,
            COUNT(r.id) FILTER (WHERE r.status = 'ACTIVE')::int AS active_count
       FROM listings l
       LEFT JOIN reservations r ON r.listing_id = l.id
      WHERE l.listing_reference = $1
      GROUP BY l.id`,
    [listingReference],
  );
  return r.rows[0] as {
    total_stock: number;
    available_stock: number;
    active_reserved: number;
    reservations: number;
    active_count: number;
  };
}

/** TOTAL = AVAILABLE + SUM(ACTIVE reservations), straight from the database. */
export async function expectInvariant(listingReference: string) {
  const s = await stockOf(listingReference);
  if (s.total_stock !== s.available_stock + s.active_reserved) {
    throw new Error(`Invariant broken for ${listingReference}: ${JSON.stringify(s)}`);
  }
  if (s.available_stock < 0) throw new Error(`Negative stock for ${listingReference}`);
  return s;
}

export async function eventsFor(reservationId: string): Promise<string[]> {
  const r = await pool.query(
    'SELECT event_type FROM reservation_events WHERE reservation_id = $1 ORDER BY seq',
    [reservationId],
  );
  return r.rows.map((x) => x.event_type);
}
