import { afterAll, describe, expect, it } from 'vitest';
import { app, eventsFor, expectInvariant, makeListing, pool, request, reservationBody, reserve, stockOf, uniq } from './helpers';

afterAll(() => pool.end());

describe('Test 1: successful reservation', () => {
  it('reserves 2 of 5: ACTIVE, available becomes 3', async () => {
    const ref = await makeListing(5);
    const res = await reserve(reservationBody(ref, 2));
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.replayed).toBe(false);
    expect(res.body.reservation.status).toBe('ACTIVE');
    expect(res.body.reservation.quantity).toBe(2);

    const listing = await request(app).get(`/api/listings/${ref}`);
    expect(listing.body.listing.availableStock).toBe(3);
    expect(listing.body.listing.invariantHolds).toBe(true);
    await expectInvariant(ref);

    const events = await eventsFor(res.body.reservation.id);
    expect(events).toEqual(['RESERVATION_REQUESTED', 'RESERVATION_CREATED']);
  });

  it('applies the configured expiry window (default 15 minutes)', async () => {
    const ref = await makeListing(1);
    const res = await reserve(reservationBody(ref, 1));
    const ms = new Date(res.body.reservation.expiresAt).getTime() - new Date(res.body.reservation.createdAt).getTime();
    expect(ms).toBeGreaterThan(14 * 60_000);
    expect(ms).toBeLessThan(16 * 60_000);
  });

  it('can retrieve a reservation by id', async () => {
    const ref = await makeListing(1);
    const created = await reserve(reservationBody(ref, 1));
    const res = await request(app).get(`/api/reservations/${created.body.reservation.id}`);
    expect(res.status).toBe(200);
    expect(res.body.reservation.id).toBe(created.body.reservation.id);
    expect((await request(app).get('/api/reservations/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('Test 2: insufficient stock', () => {
  it('rejects 3 of 2 with 409, stock unchanged, no reservation created', async () => {
    const ref = await makeListing(2);
    const res = await reserve(reservationBody(ref, 3));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');

    const s = await stockOf(ref);
    expect(s.available_stock).toBe(2);
    expect(s.reservations).toBe(0);
    await expectInvariant(ref);
  });

  it('records a RESERVATION_REJECTED audit event for the failed attempt', async () => {
    const ref = await makeListing(1);
    const body = reservationBody(ref, 5);
    await reserve(body);
    const res = await request(app).get(`/api/events?eventType=RESERVATION_REJECTED&listingReference=${ref}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].eventDetails).toMatchObject({ reason: 'INSUFFICIENT_STOCK', quantity: 5 });
  });

  it('allows reserving exactly the remaining stock, then rejects one more', async () => {
    const ref = await makeListing(3);
    expect((await reserve(reservationBody(ref, 3))).status).toBe(201);
    expect((await reserve(reservationBody(ref, 1))).status).toBe(409);
    expect((await stockOf(ref)).available_stock).toBe(0);
  });
});

describe('Test 9: invalid quantities', () => {
  it.each([
    ['zero', { quantity: 0 }],
    ['negative', { quantity: -2 }],
    ['decimal', { quantity: 1.5 }],
    ['string', { quantity: '2' }],
    ['null', { quantity: null }],
    ['boolean', { quantity: true }],
    ['array', { quantity: [2] }],
    ['object', { quantity: { n: 2 } }],
  ])('rejects %s quantity', async (_n, patch) => {
    const ref = await makeListing(5);
    const res = await reserve(reservationBody(ref, 1, patch));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const s = await stockOf(ref);
    expect(s.available_stock).toBe(5);
    expect(s.reservations).toBe(0);
  });

  it('rejects a missing quantity', async () => {
    const ref = await makeListing(5);
    const { quantity: _q, ...body } = reservationBody(ref, 1);
    const res = await reserve(body);
    expect(res.status).toBe(400);
    expect((await stockOf(ref)).available_stock).toBe(5);
  });

  it.each(['buyerReference', 'orderReference', 'idempotencyKey', 'listingReference'])('rejects a missing %s', async (field) => {
    const ref = await makeListing(5);
    const body: Record<string, unknown> = reservationBody(ref, 1);
    delete body[field];
    const res = await reserve(body);
    expect(res.status).toBe(400);
    expect((await stockOf(ref)).available_stock).toBe(5);
  });
});

describe('Test 10: unknown listing', () => {
  it('returns 404 and creates nothing', async () => {
    const body = reservationBody(uniq('NOPE'), 1);
    const res = await reserve(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LISTING_NOT_FOUND');
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM reservations WHERE idempotency_key = $1', [body.idempotencyKey]);
    expect(count.rows[0].n).toBe(0);
  });
});

describe('events endpoint', () => {
  it('paginates and never exposes configuration', async () => {
    const ref = await makeListing(5);
    await reserve(reservationBody(ref, 1));
    const page = await request(app).get('/api/events?limit=2&offset=0');
    expect(page.status).toBe(200);
    expect(page.body.events.length).toBeLessThanOrEqual(2);
    expect(page.body.pagination).toMatchObject({ limit: 2, offset: 0 });
    expect(page.body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(page.body)).not.toMatch(/postgres:\/\/|password|DATABASE_URL/i);
    expect((await request(app).get('/api/events?limit=0')).status).toBe(400);
    expect((await request(app).get('/api/events?limit=1000')).status).toBe(400);
    expect((await request(app).get('/api/events?eventType=BOGUS')).status).toBe(400);
  });
});
