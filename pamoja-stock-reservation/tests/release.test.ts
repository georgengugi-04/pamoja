import { afterAll, describe, expect, it } from 'vitest';
import { app, eventsFor, expectInvariant, makeListing, pool, request, reservationBody, reserve, stockOf } from './helpers';

afterAll(() => pool.end());

const release = (id: string) => request(app).post(`/api/reservations/${id}/release`);
const processExpired = () => request(app).post('/api/reservations/process-expired');

async function reserveUnits(stock: number, qty: number) {
  const ref = await makeListing(stock);
  const res = await reserve(reservationBody(ref, qty));
  return { ref, id: res.body.reservation.id as string };
}

async function makeExpired(id: string) {
  await pool.query(`UPDATE reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);
}

describe('Test 6: successful release', () => {
  it('releases a 2-unit reservation from stock 5 and restores availability to 5', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    expect((await stockOf(ref)).available_stock).toBe(3);

    const res = await release(id);
    expect(res.status).toBe(200);
    expect(res.body.reservation.status).toBe('RELEASED');

    const s = await expectInvariant(ref);
    expect(s.available_stock).toBe(5);
    expect(s.active_count).toBe(0);
    expect(await eventsFor(id)).toContain('RESERVATION_RELEASED');
  });

  it('released stock can be reserved again', async () => {
    const { ref, id } = await reserveUnits(2, 2);
    expect((await reserve(reservationBody(ref, 1))).status).toBe(409);
    await release(id);
    expect((await reserve(reservationBody(ref, 2))).status).toBe(201);
  });
});

describe('Test 7: repeated release', () => {
  it('second release is rejected with 409 and stock is unchanged', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    await release(id);
    const again = await release(id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const s = await expectInvariant(ref);
    expect(s.available_stock).toBe(5); // not 7
  });
});

describe('Test 8: invalid release', () => {
  it('unknown reservation id -> 404, no stock modified', async () => {
    const { ref } = await reserveUnits(5, 2);
    const res = await release('00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect((await expectInvariant(ref)).available_stock).toBe(3);
  });

  it('malformed reservation id -> 404 (not a database error)', async () => {
    const res = await release('not-a-uuid');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/invalid input syntax|uuid/i);
  });
});

describe('Test 11: expiry processing', () => {
  it('expires a past-due ACTIVE reservation, restores stock exactly once, records an event', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    await makeExpired(id);

    const first = await processExpired();
    expect(first.status).toBe(200);
    expect(first.body.reservationIds).toContain(id);

    const got = await request(app).get(`/api/reservations/${id}`);
    expect(got.body.reservation.status).toBe('EXPIRED');
    let s = await expectInvariant(ref);
    expect(s.available_stock).toBe(5);
    expect(await eventsFor(id)).toContain('RESERVATION_EXPIRED');

    // running it again must not restore stock twice
    const second = await processExpired();
    expect(second.body.reservationIds).not.toContain(id);
    s = await expectInvariant(ref);
    expect(s.available_stock).toBe(5);
  });

  it('does not touch reservations that have not expired', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    await processExpired();
    expect((await request(app).get(`/api/reservations/${id}`)).body.reservation.status).toBe('ACTIVE');
    expect((await expectInvariant(ref)).available_stock).toBe(3);
  });

  it('does not expire a RELEASED reservation (no double restore)', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    await release(id);
    await makeExpired(id);
    await processExpired();
    expect((await request(app).get(`/api/reservations/${id}`)).body.reservation.status).toBe('RELEASED');
    expect((await expectInvariant(ref)).available_stock).toBe(5);
  });

  it('releasing an EXPIRED reservation is rejected and does not restore stock again', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    await makeExpired(id);
    await processExpired();
    const res = await release(id);
    expect(res.status).toBe(409);
    expect((await expectInvariant(ref)).available_stock).toBe(5);
  });

  it('two concurrent expiry sweeps restore stock exactly once', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    await makeExpired(id);
    await Promise.all([processExpired(), processExpired(), processExpired()]);
    expect((await request(app).get(`/api/reservations/${id}`)).body.reservation.status).toBe('EXPIRED');
    expect((await expectInvariant(ref)).available_stock).toBe(5);
    const n = await pool.query(
      `SELECT COUNT(*)::int AS n FROM reservation_events WHERE reservation_id=$1 AND event_type='RESERVATION_EXPIRED'`,
      [id],
    );
    expect(n.rows[0].n).toBe(1);
  });
});

describe('Test 12: concurrent release protection', () => {
  it('two simultaneous releases of one reservation restore the quantity once', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    const [a, b] = await Promise.all([release(id), release(id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const s = await expectInvariant(ref);
    expect(s.available_stock).toBe(5);
    const n = await pool.query(
      `SELECT COUNT(*)::int AS n FROM reservation_events WHERE reservation_id=$1 AND event_type='RESERVATION_RELEASED'`,
      [id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('10 simultaneous releases -> exactly one succeeds', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    const results = await Promise.all(Array.from({ length: 10 }, () => release(id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await expectInvariant(ref)).available_stock).toBe(5);
  });

  it('release racing expiry: stock is restored exactly once whichever wins', async () => {
    const { ref, id } = await reserveUnits(5, 2);
    await makeExpired(id);
    const [rel] = await Promise.all([release(id), processExpired(), processExpired()]);
    expect([200, 409]).toContain(rel.status);
    const final = (await request(app).get(`/api/reservations/${id}`)).body.reservation.status;
    expect(['RELEASED', 'EXPIRED']).toContain(final);
    expect((await expectInvariant(ref)).available_stock).toBe(5);
  });
});

describe('database-level protections', () => {
  it('rejects negative available stock and available > total even for direct SQL', async () => {
    const ref = await makeListing(2);
    await expect(pool.query(`UPDATE listings SET available_stock = -1 WHERE listing_reference=$1`, [ref])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE listings SET available_stock = 3 WHERE listing_reference=$1`, [ref])).rejects.toMatchObject({ code: '23514' });
    expect((await stockOf(ref)).available_stock).toBe(2);
  });

  it('rejects non-positive reservation quantities and unknown statuses at the database', async () => {
    const ref = await makeListing(2);
    const listingId = (await pool.query('SELECT id FROM listings WHERE listing_reference=$1', [ref])).rows[0].id;
    const insert = (qty: number, status: string, key: string) =>
      pool.query(
        `INSERT INTO reservations (listing_id,buyer_reference,order_reference,idempotency_key,quantity,status,expires_at)
         VALUES ($1,'b','o',$2,$3,$4,NOW())`,
        [listingId, key, qty, status],
      );
    await expect(insert(0, 'ACTIVE', 'k-zero')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(1, 'BOGUS', 'k-bogus')).rejects.toMatchObject({ code: '23514' });
  });
});
