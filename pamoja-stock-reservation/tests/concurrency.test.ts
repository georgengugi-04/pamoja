import { afterAll, describe, expect, it } from 'vitest';
import { createReservation } from '../src/modules/reservations/reservation.service';
import { expectInvariant, makeListing, pool, reservationBody, reserve, stockOf } from './helpers';

afterAll(() => pool.end());

/**
 * Methodology: every request below is started in the same tick with Promise.all and each one checks
 * out its OWN connection from the pg pool, so the transactions genuinely overlap inside PostgreSQL.
 * Outcomes are then verified from the database itself, not from the API responses alone.
 */
describe('Test 3: concurrent reservation protection', () => {
  it('service level: two concurrent requests for 2 units of a 2-unit listing -> exactly one wins', async () => {
    const ref = await makeListing(2);
    const results = await Promise.allSettled([
      createReservation(reservationBody(ref, 2) as never),
      createReservation(reservationBody(ref, 2) as never),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.code).toBe('INSUFFICIENT_STOCK');

    const s = await expectInvariant(ref);
    expect(s.available_stock).toBe(0);
    expect(s.active_count).toBe(1);
    expect(s.active_reserved).toBe(2);
    expect(s.reservations).toBe(1);
  });

  it('HTTP level: two concurrent POSTs for 2 units of a 2-unit listing -> one 201, one 409', async () => {
    const ref = await makeListing(2);
    const [a, b] = await Promise.all([
      reserve(reservationBody(ref, 2, { buyerReference: 'BUYER-A' })),
      reserve(reservationBody(ref, 2, { buyerReference: 'BUYER-B' })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('INSUFFICIENT_STOCK');

    const s = await expectInvariant(ref);
    expect(s.available_stock).toBe(0);
    expect(s.active_count).toBe(1);
    expect(s.active_reserved).toBe(2);
  });

  it('stress: 25 concurrent single-unit requests against 10 units -> exactly 10 succeed, stock never negative', async () => {
    const ref = await makeListing(10);
    const responses = await Promise.all(Array.from({ length: 25 }, () => reserve(reservationBody(ref, 1))));
    const created = responses.filter((r) => r.status === 201).length;
    const rejected = responses.filter((r) => r.status === 409).length;
    expect(created).toBe(10);
    expect(rejected).toBe(15);
    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);

    const s = await expectInvariant(ref);
    expect(s.available_stock).toBe(0);
    expect(s.active_reserved).toBe(10);
    expect(s.reservations).toBe(10);
  });

  it('stress: mixed quantities never exceed total stock', async () => {
    const ref = await makeListing(20);
    const qty = [5, 4, 3, 3, 2, 2, 5, 4, 1, 1, 6, 7, 2, 3];
    const responses = await Promise.all(qty.map((q) => reserve(reservationBody(ref, q))));
    const reservedByApi = responses
      .filter((r) => r.status === 201)
      .reduce((sum, r) => sum + r.body.reservation.quantity, 0);
    const s = await expectInvariant(ref);
    expect(reservedByApi).toBe(s.active_reserved);
    expect(s.active_reserved).toBeLessThanOrEqual(20);
    expect(s.available_stock).toBe(20 - reservedByApi);
  });

  it('a rejected concurrent request leaves no partial decrement', async () => {
    const ref = await makeListing(3);
    await Promise.all([reserve(reservationBody(ref, 3)), reserve(reservationBody(ref, 3)), reserve(reservationBody(ref, 3))]);
    const s = await stockOf(ref);
    expect(s.available_stock).toBe(0);
    expect(s.active_count).toBe(1);
  });
});
