import { afterAll, describe, expect, it } from 'vitest';
import { eventsFor, expectInvariant, makeListing, pool, reservationBody, reserve, stockOf, uniq } from './helpers';

afterAll(() => pool.end());

describe('Test 4: idempotent retry', () => {
  it('same key + same parameters returns the original reservation and deducts stock once', async () => {
    const ref = await makeListing(5);
    const body = reservationBody(ref, 2);

    const first = await reserve(body);
    const second = await reserve(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.reservation.id).toBe(first.body.reservation.id);

    const s = await expectInvariant(ref);
    expect(s.reservations).toBe(1);
    expect(s.available_stock).toBe(3);

    expect(await eventsFor(first.body.reservation.id)).toContain('IDEMPOTENT_REPLAY');
  });

  it('a replay still works after the listing is sold out', async () => {
    const ref = await makeListing(2);
    const body = reservationBody(ref, 2);
    const first = await reserve(body);
    const replay = await reserve(body); // stock is 0 now, but this is the same logical request
    expect(replay.status).toBe(200);
    expect(replay.body.reservation.id).toBe(first.body.reservation.id);
    expect((await stockOf(ref)).available_stock).toBe(0);
  });
});

describe('Test 5: idempotency key reuse with different details', () => {
  it('different quantity -> 409 and no extra deduction', async () => {
    const ref = await makeListing(5);
    const body = reservationBody(ref, 2);
    await reserve(body);
    const res = await reserve({ ...body, quantity: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const s = await expectInvariant(ref);
    expect(s.available_stock).toBe(3);
    expect(s.reservations).toBe(1);
  });

  it('different listing -> 409 and neither listing is touched', async () => {
    const refA = await makeListing(5);
    const refB = await makeListing(5);
    const body = reservationBody(refA, 1);
    await reserve(body);
    const res = await reserve({ ...body, listingReference: refB });
    expect(res.status).toBe(409);
    expect((await stockOf(refB)).available_stock).toBe(5);
    expect((await stockOf(refB)).reservations).toBe(0);
    expect((await stockOf(refA)).available_stock).toBe(4);
  });

  it('different buyer or order reference -> 409', async () => {
    const ref = await makeListing(5);
    const body = reservationBody(ref, 1);
    await reserve(body);
    expect((await reserve({ ...body, buyerReference: uniq('OTHER') })).status).toBe(409);
    expect((await reserve({ ...body, orderReference: uniq('OTHER') })).status).toBe(409);
    expect((await stockOf(ref)).available_stock).toBe(4);
  });
});

describe('simultaneous requests with the SAME idempotency key', () => {
  it('10 concurrent identical requests -> one reservation, stock deducted once, all return the same id', async () => {
    const ref = await makeListing(5);
    const body = reservationBody(ref, 2);
    const responses = await Promise.all(Array.from({ length: 10 }, () => reserve(body)));

    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const ids = new Set(responses.map((r) => r.body.reservation.id));
    expect(ids.size).toBe(1);

    const s = await expectInvariant(ref);
    expect(s.reservations).toBe(1);
    expect(s.available_stock).toBe(3);
  });

  it('concurrent duplicates when stock covers only ONE request still replay (not "insufficient stock")', async () => {
    const ref = await makeListing(2);
    const body = reservationBody(ref, 2);
    const responses = await Promise.all(Array.from({ length: 6 }, () => reserve(body)));
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.body.reservation.id)).size).toBe(1);
    const s = await expectInvariant(ref);
    expect(s.available_stock).toBe(0);
    expect(s.reservations).toBe(1);
  });

  it('concurrent requests reusing one key with DIFFERENT details: one wins, others get 409', async () => {
    const ref = await makeListing(10);
    const key = uniq('shared-key');
    const responses = await Promise.all(
      [1, 2, 3, 4].map((q) => reserve(reservationBody(ref, 1, { quantity: q, idempotencyKey: key, buyerReference: 'B', orderReference: 'O' }))),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(3);
    const s = await expectInvariant(ref);
    expect(s.reservations).toBe(1);
  });

  it('the database unique constraint is the final authority', async () => {
    const ref = await makeListing(5);
    const body = reservationBody(ref, 1);
    const first = await reserve(body);
    const listingId = (await pool.query('SELECT id FROM listings WHERE listing_reference=$1', [ref])).rows[0].id;
    await expect(
      pool.query(
        `INSERT INTO reservations (listing_id, buyer_reference, order_reference, idempotency_key, quantity, expires_at)
         VALUES ($1,'x','y',$2,1,NOW() + INTERVAL '1 minute')`,
        [listingId, body.idempotencyKey],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'reservations_idempotency_key_key' });
    expect(first.status).toBe(201);
  });
});
