/**
 * Reproducible end-to-end demonstration against the real API and the real PostgreSQL database
 * configured by DATABASE_URL. It starts the app on an ephemeral local port, so nothing else needs
 * to be running (but PostgreSQL must be up and migrated: docker compose up -d && npm run db:migrate).
 *
 * DEMO-ONLY CLEANUP: because the scenario uses the fixed reference PART-001, any previous
 * PART-001 demo data in the development database is deleted first so the demo is repeatable.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/config/database';

let base = '';

async function call(label: string, method: string, path: string, body?: unknown) {
  console.log(`\n### ${label}`);
  console.log(`> ${method} ${path}`);
  if (body !== undefined) console.log(JSON.stringify(body, null, 2));
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  console.log(`< HTTP ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  return { status: res.status, json } as { status: number; json: any };
}

async function resetDemoData() {
  const found = await pool.query(`SELECT id FROM listings WHERE listing_reference = 'PART-001'`);
  if (found.rowCount === 0) return;
  const id = found.rows[0].id;
  await pool.query('DELETE FROM reservation_events WHERE listing_id = $1 OR reservation_id IN (SELECT id FROM reservations WHERE listing_id = $1)', [id]);
  await pool.query('DELETE FROM reservations WHERE listing_id = $1', [id]);
  await pool.query('DELETE FROM listings WHERE id = $1', [id]);
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`DEMO ASSERTION FAILED: ${msg}`);
  console.log(`   ✔ ${msg}`);
}

async function main() {
  await resetDemoData();
  const server = http.createServer(createApp()).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`PAMOJA stock reservation demo -> ${base}`);

  try {
    await call('0. Health check', 'GET', '/health');

    const listing = await call('1. Create listing PART-001 with stock 2', 'POST', '/api/listings', {
      listingReference: 'PART-001',
      totalStock: 2,
    });
    assert(listing.status === 201 && listing.json.listing.availableStock === 2, 'listing created with 2 units');

    // Buyer A and Buyer B compete at the same moment for the last 2 units.
    const reqA = { listingReference: 'PART-001', quantity: 2, buyerReference: 'BUYER-A', orderReference: 'ORDER-A', idempotencyKey: 'demo-reserve-A' };
    const reqB = { listingReference: 'PART-001', quantity: 2, buyerReference: 'BUYER-B', orderReference: 'ORDER-B', idempotencyKey: 'demo-reserve-B' };
    console.log('\n### 2-3. Buyer A and Buyer B request 2 units each, CONCURRENTLY (Promise.all)');
    const [a, b] = await Promise.all([
      fetch(base + '/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqA) }),
      fetch(base + '/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqB) }),
    ]);
    const aj: any = await a.json();
    const bj: any = await b.json();
    console.log(`Buyer A -> HTTP ${a.status}\n${JSON.stringify(aj, null, 2)}`);
    console.log(`Buyer B -> HTTP ${b.status}\n${JSON.stringify(bj, null, 2)}`);

    const winner = a.status === 201 ? { buyer: 'A', json: aj } : { buyer: 'B', json: bj };
    const loser = a.status === 201 ? { buyer: 'B', status: b.status, json: bj } : { buyer: 'A', status: a.status, json: aj };
    console.log(`\n(The database decided the race: Buyer ${winner.buyer} won this run. Which buyer wins can vary between runs; exactly one always does.)`);
    assert([a.status, b.status].sort().join() === '201,409', 'exactly one request succeeded (201) and one was rejected (409)');
    assert(winner.json.reservation.status === 'ACTIVE', `Buyer ${winner.buyer}'s reservation is ACTIVE`);
    assert(loser.json.error.code === 'INSUFFICIENT_STOCK', `Buyer ${loser.buyer} rejected: INSUFFICIENT_STOCK`);

    const mid = await call('4. Listing stock after the race', 'GET', '/api/listings/PART-001');
    assert(mid.json.listing.availableStock === 0, 'available stock is 0');
    assert(mid.json.listing.invariantHolds === true, 'invariant: total (2) = available (0) + active reserved (2)');

    const retry = await call(
      `5. Idempotent retry of Buyer ${winner.buyer}'s request (same key, same parameters)`,
      'POST',
      '/api/reservations',
      winner.buyer === 'A' ? reqA : reqB,
    );
    assert(retry.status === 200 && retry.json.replayed === true, 'replay returns the original reservation (HTTP 200)');
    assert(retry.json.reservation.id === winner.json.reservation.id, 'same reservation id, stock not deducted again');

    const rel = await call(
      `6. Release Buyer ${winner.buyer}'s reservation`,
      'POST',
      `/api/reservations/${winner.json.reservation.id}/release`,
    );
    assert(rel.json.reservation.status === 'RELEASED', 'reservation is RELEASED');

    const end = await call('7. Listing stock after release', 'GET', '/api/listings/PART-001');
    assert(end.json.listing.availableStock === 2, 'available stock restored to 2');
    assert(end.json.listing.invariantHolds === true, 'invariant holds: total (2) = available (2) + active reserved (0)');

    const again = await call('8. Repeated release is rejected and does not restore stock twice', 'POST', `/api/reservations/${winner.json.reservation.id}/release`);
    assert(again.status === 409, 'second release rejected with 409');
    const final = await call('   Listing stock after the rejected second release', 'GET', '/api/listings/PART-001');
    assert(final.json.listing.availableStock === 2, 'available stock still 2 (not 4)');

    await call('9. Audit trail for PART-001', 'GET', '/api/events?listingReference=PART-001&limit=20');
    console.log('\nDemo completed successfully.');
  } finally {
    server.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
