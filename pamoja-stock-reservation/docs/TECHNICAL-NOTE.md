# Technical Note: Reliable Stock Reservation Service

PAMOJA AutoParts Exchange, Stage 5, Exercise 01. Candidate: George Ngugi.

This note explains how the prototype works and, just as importantly, where it stops. It is a bounded exercise, not a production inventory system.

## 1. Database model

Three tables (`database/migrations/001_initial_schema.sql`). Rules that the database can enforce are enforced there, so a bug in application code cannot silently break inventory.

| Table | Purpose | Key constraints |
|---|---|---|
| `listings` | One row per sellable listing; holds the stock counters | unique `listing_reference`; `total_stock >= 0`; `available_stock >= 0`; `available_stock <= total_stock`; reference format check |
| `reservations` | One row per reservation | FK to `listings`; unique `idempotency_key` (named constraint); `quantity > 0`; `status IN ('ACTIVE','RELEASED','EXPIRED')`; `expires_at NOT NULL` |
| `reservation_events` | Append-only audit trail | nullable FKs (`ON DELETE SET NULL`); `event_type` restricted to the seven required types; `event_details` JSONB |

All ids are UUIDs (`gen_random_uuid()`). Partial index `reservations (expires_at) WHERE status = 'ACTIVE'` keeps expiry scans cheap.

## 2. How listing stock is represented

Two integer counters on the listing row: `total_stock` (what exists) and `available_stock` (what can still be reserved). Reservations do not "hold" rows of stock; they hold a quantity. The relationship is:

```
total_stock = available_stock + SUM(quantity of ACTIVE reservations)
```

`available_stock` is a denormalised counter so that the oversell guard is a single-row atomic operation. The invariant above ties the counter back to the reservation rows, and it is checked from the database in `GET /api/listings/:ref` (`invariantHolds`) and throughout the tests.

## 3. How the reservation transaction works

`createReservation` runs one PostgreSQL transaction (`BEGIN ... COMMIT`, default READ COMMITTED):

1. Validate the request (Zod, before the database is touched).
2. Look up the idempotency key. Same key and same logical request: return the original reservation (HTTP 200), no stock change. Same key but different details: 409.
3. Check the listing exists (404 otherwise).
4. Atomic conditional decrement (section 4).
5. Insert the reservation (`ACTIVE`, `expires_at = NOW() + TTL`).
6. Insert `RESERVATION_REQUESTED` and `RESERVATION_CREATED` events.
7. `COMMIT`.

Any thrown error triggers `ROLLBACK`, so the decrement, reservation and events succeed or fail together. There is no code path that changes stock outside the transaction.

## 4. Why the atomic conditional update prevents overselling

```sql
UPDATE listings
   SET available_stock = available_stock - $1, updated_at = NOW()
 WHERE id = $2 AND available_stock >= $1
RETURNING id, available_stock;
```

The "is there enough?" test and the decrement are one statement evaluated by the database against the current row. There is no gap between checking and writing for another request to slip into, which is the gap that a read-then-write implementation (`SELECT`, compare in Node, `UPDATE`) leaves open. If zero rows come back, the service reports `INSUFFICIENT_STOCK` (or 404 if the listing vanished).

This was verified empirically: replacing this statement with a naive read-then-write version made all five concurrency tests fail.

The `CHECK (available_stock >= 0)` constraint is a second, independent safety net: even a future code mistake cannot commit a negative balance.

## 5. How PostgreSQL handles competing updates to the same listing

An `UPDATE` takes a row-level lock. When two transactions try to update the same listing row at once, the second waits until the first commits or rolls back. Under READ COMMITTED, PostgreSQL then re-evaluates the second statement's `WHERE` clause against the newly committed row version, so the second request sees the already-reduced stock. With 2 units and two requests for 2, the loser re-checks `available_stock >= 2` against 0, matches no row, and is rejected. Requests for different listings touch different rows and do not block each other.

No explicit `SELECT ... FOR UPDATE` and no SERIALIZABLE isolation are needed for the stock decrement; the single conditional statement carries the correctness.

## 6. How idempotency is implemented

* Every reservation request carries an `idempotencyKey`, stored with the reservation and protected by a database `UNIQUE` constraint.
* "Same logical request" means same listing, quantity, buyer reference and order reference.
* Identical retry: original reservation returned with HTTP 200 and `replayed: true`; stock is not touched; an `IDEMPOTENT_REPLAY` event is recorded.
* Key reused with different details: HTTP 409 `IDEMPOTENCY_KEY_REUSED`, explaining that a key cannot be reused for a different operation.

## 7. How simultaneous duplicate requests are handled

The application-level lookup in step 2 cannot see a reservation another transaction has not yet committed, so concurrent duplicates can both pass it. The unique constraint is the final authority:

1. Both transactions decrement stock; the second waits on the row lock.
2. The first inserts its reservation and commits.
3. The second proceeds and its `INSERT` violates `reservations_idempotency_key_key` (SQLSTATE 23505).
4. The second transaction **rolls back**, which undoes its own decrement, so stock is deducted exactly once.
5. The service then re-reads the committed reservation by key and returns it as a replay (200), or 409 if the details differ.

One subtle case is handled explicitly: if the winner took the last units, the duplicate's decrement finds no stock and would otherwise report `INSUFFICIENT_STOCK` for what is really a retry. On `INSUFFICIENT_STOCK` the service therefore also re-checks the key before reporting a rejection. Tests: 10 identical concurrent requests; 6 concurrent duplicates when stock covers only one; concurrent same-key requests with different details.

## 8. How reservation release works

`releaseReservation` runs in one transaction:

1. `SELECT ... FOR UPDATE` on the reservation row (locks it).
2. Unknown or malformed id: 404. Status not `ACTIVE`: 409 `INVALID_STATE_TRANSITION`.
3. `UPDATE reservations SET status='RELEASED' ... WHERE status='ACTIVE'`.
4. `UPDATE listings SET available_stock = available_stock + quantity` (the `available <= total` check blocks returning more than was ever taken).
5. Insert `RESERVATION_RELEASED` event; commit.

Concurrent releases of the same reservation serialise on the row lock; the loser wakes up, sees a non-ACTIVE status and is rejected without touching stock. Test: 2 and 10 simultaneous releases restore stock exactly once.

## 9. How expiry works

`processExpiredReservations` (exposed as `POST /api/reservations/process-expired`, and optionally run by an in-process timer if `EXPIRY_SWEEP_INTERVAL_SECONDS > 0`):

1. In a transaction, select `ACTIVE` reservations with `expires_at <= NOW()` using `FOR UPDATE SKIP LOCKED`, ordered by `(listing_id, id)`, in batches of 200.
2. For each: set `EXPIRED` (guarded by `status='ACTIVE'`), add the quantity back to the listing, record `RESERVATION_EXPIRED`.
3. Repeat until a batch comes back short.

`SKIP LOCKED` means concurrent sweeps never process the same row, and a reservation being released at that instant is skipped rather than double-restored. If expiry wins, a later release gets 409. Ordering by listing reduces deadlock risk between concurrent sweeps. Tests cover repeated sweeps, concurrent sweeps, expiry vs release, and expiry ignoring RELEASED/unexpired rows.

The default lifetime is 15 minutes via `RESERVATION_TTL_MINUTES`. This is a prototype assumption, not an approved business policy.

## 10. How reservation events are recorded

`reservation_events` is append-only, ordered by an internal `seq`. Events that describe a committed change (`LISTING_CREATED`, `RESERVATION_REQUESTED`/`CREATED`, `RESERVATION_RELEASED`, `RESERVATION_EXPIRED`, `IDEMPOTENT_REPLAY` on the normal path) are inserted **inside the same transaction** as the change, so an event exists if and only if the change committed.

Rejections roll the main transaction back, which would erase an event written inside it. So `RESERVATION_REQUESTED` + `RESERVATION_REJECTED` (with a reason code) are written afterwards in a separate autocommit transaction that never touches stock. That audit write is best-effort: if it fails, it is logged and the original outcome is unchanged. Events contain codes, quantities and the idempotency key, no secrets and no stack traces.

## 11. Concurrency tests executed

Summarised from `tests/` (64 tests, real PostgreSQL; see README for the verbose run and methodology):

* Two concurrent requests for 2 units of a 2-unit listing, at service level and over HTTP: exactly one succeeds, stock 0, one ACTIVE reservation, invariant holds.
* 25 concurrent single-unit requests against 10 units: exactly 10 created, 15 rejected.
* Mixed concurrent quantities never exceed total stock; the API's total of accepted quantities equals the database's active total.
* 10 and 6 concurrent identical idempotent requests: one reservation, stock deducted once (including the sold-out case).
* Concurrent same-key requests with different details: one wins, the rest get 409.
* 2 and 10 simultaneous releases: stock restored once.
* Concurrent expiry sweeps; release racing expiry: stock restored exactly once.
* Direct-SQL probes proving the CHECK and UNIQUE constraints reject bad data independently of application code.

Plus a mutation check (naive read-then-write) that failed all concurrency tests. Honest caveat: parallel connections make overlap very likely but the exact interleaving cannot be forced from application code; the suite passed 10 of 10 consecutive full runs.

## 12. Known limitations

* **Unswept expired reservations still hold stock.** Until a sweep runs, a past-due `ACTIVE` reservation keeps consuming availability (and can still be released). Expiry is poll-based, not instantaneous.
* **Replay returns current state.** A replay returns the reservation as it is now (it may already be `RELEASED` or `EXPIRED`) with HTTP 200; the original response is not cached byte-for-byte.
* **Failed requests do not "burn" the key.** A rejected request (for example insufficient stock) stores nothing, so retrying the same key later is re-evaluated against current stock. This matches "a failed reservation does not consume stock" but is a design choice.
* **Idempotency keys are global and never expire.** Not scoped per buyer; no retention policy.
* **Single hot row per listing.** All reservations for one listing serialise on its row lock. Fine at this scale; very hot listings could become a bottleneck.
* **Single database only.** This is not a solution to distributed-systems problems: no multi-region, no cross-service sagas, no read replicas, no exactly-once delivery to other systems.
* **No authentication, authorisation, rate limiting or request signing.** Anyone who can reach the API can reserve or release.
* **Audit events for rejections are best-effort** and are not atomic with anything.
* **Events for rejected requests against unknown listings have a null `listing_id`.**
* **Expiry processing is global.** The sweep is not scoped per listing; tests tolerate this by using unique data and running files serially.
* Test and demo data accumulate in the databases (tests use unique references; the demo resets only `PART-001`).
* Docker Compose was not executed in the authoring environment (see README).

## 13. Assumptions requiring PAMOJA approval

Provisional implementation decisions, to be confirmed before any production use:

1. PostgreSQL as the single source of truth for inventory.
2. Reservation lifetime of 15 minutes (configurable). Policy may differ by buyer type, listing type or checkout step.
3. Whether expired-but-unswept reservations should stop counting against availability immediately, and the sweep cadence.
4. Idempotency semantics: key scope (global vs per buyer/tenant), retention period, and whether replays should return a frozen original response.
5. Who may release a reservation, and whether partial release or quantity changes are needed.
6. Whether a released reservation may be revived or whether a new request is always required.
7. Quantity limits per buyer/order and handling of backorders or pre-orders.
8. How reservations connect to payment confirmation (consumption into a sale), which is out of scope here: no payment integration, no M-Pesa.
9. Buyer and order references are test identifiers; real identity, access control and personal-data handling need a privacy review.
10. Audit event retention, access and redaction rules.
11. Expected load and hot-listing behaviour, which would drive any sharding, queueing or caching design.
