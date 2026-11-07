# PAMOJA Stock Reservation Service

Stage 5 bounded implementation exercise: a small, transactionally safe stock reservation service for the PAMOJA AutoParts Exchange.
**Candidate:** George Ngugi

It prevents overselling under concurrent requests, makes retries safe with idempotency keys, supports release and expiry of reservations, and proves all of this with automated tests that run against a real PostgreSQL database.

Stack: Node.js, TypeScript, Express, PostgreSQL (`pg`), Zod, dotenv, Vitest + Supertest, Docker Compose.

## Quick start

Requirements: Node.js 20+, Docker Desktop (running), and a terminal in the project folder.

**Windows PowerShell** (run one command at a time):

```powershell
npm install
Copy-Item .env.example .env
docker compose up -d          # PostgreSQL 16 (creates `pamoja` and `pamoja_test` databases)
npm run db:migrate            # apply database/migrations/*.sql
npm test                      # full suite (migrates + resets the TEST database itself)
npm run demo                  # scripted PART-001 scenario with real HTTP requests/responses
npm run typecheck             # tsc --noEmit
npm run dev                   # API on http://localhost:3000 (leave this terminal open)
```

**macOS / Linux** is the same, except use `cp .env.example .env` instead of `Copy-Item`.

To run the API on a different port (for example if 3000 is taken), set `PORT` in `.env`, or for one session in PowerShell: `$env:PORT="3001"; npm run dev`.

Optional: `npm run db:seed` (two sample listings), `npm run build && npm start` (compiled server), `docker compose --profile app up -d --build` (API in Docker as well).

Configuration (`.env`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Development database |
| `TEST_DATABASE_URL` | Separate database used only by the tests (tests refuse to run without it) |
| `RESERVATION_TTL_MINUTES` | Reservation lifetime, default 15 (**prototype assumption, not approved PAMOJA policy**) |
| `EXPIRY_SWEEP_INTERVAL_SECONDS` | Optional in-process expiry sweeper, `0` = off |
| `PORT`, `DB_POOL_MAX` | HTTP port, pool size |

`.env` is git-ignored. `.env.example` contains local-development placeholders only.

## API

| Method & path | Purpose | Success | Errors |
|---|---|---|---|
| `GET /` | Service name and list of routes | 200 | |
| `GET /health` | Liveness | 200 | |
| `POST /api/listings` | Create listing `{listingReference, totalStock}` | 201 | 400 invalid, 409 duplicate |
| `GET /api/listings/:listingReference` | Stock info + inventory invariant check | 200 | 404 |
| `POST /api/reservations` | Reserve stock | 201 new, 200 idempotent replay | 400 invalid, 404 unknown listing, 409 insufficient stock or key reused with different details |
| `GET /api/reservations/:reservationId` | Fetch reservation | 200 | 404 |
| `POST /api/reservations/:reservationId/release` | Release an ACTIVE reservation | 200 | 404 unknown/malformed id, 409 not ACTIVE |
| `POST /api/reservations/process-expired` | Expire past-due ACTIVE reservations, restore stock | 200 | |
| `GET /api/events` | Audit trail. Query: `limit` (1-200, default 50), `offset`, `eventType`, `listingReference`, `reservationId` | 200 | 400 |

Errors share one shape: `{"success": false, "error": {"code": "...", "message": "..."}}`. Database errors and stack traces are never returned.

Example (from the real demo run, see `docs/DEMO-OUTPUT.md` for the full capture):

```http
POST /api/reservations
{"listingReference":"PART-001","quantity":2,"buyerReference":"BUYER-A","orderReference":"ORDER-A","idempotencyKey":"demo-reserve-A"}

HTTP 201
{"success":true,"replayed":false,"reservation":{"id":"77877064-2ada-4248-90a2-a5e64a5b9dbf","listingReference":"PART-001","quantity":2,"status":"ACTIVE", ...}}

# Buyer B, same moment, same 2 units:
HTTP 409
{"success":false,"error":{"code":"INSUFFICIENT_STOCK","message":"Insufficient available stock on listing \"PART-001\" for quantity 2."}}
```

## Try it by hand (PowerShell, API running on port 3000)

Use a second terminal while `npm run dev` keeps running. Change the port in the URLs if you use another one.

```powershell
Invoke-RestMethod http://localhost:3000/health

Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/listings -ContentType "application/json" -Body '{"listingReference":"PART-100","totalStock":2}'

Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/reservations -ContentType "application/json" -Body '{"listingReference":"PART-100","quantity":2,"buyerReference":"BUYER-A","orderReference":"ORDER-A","idempotencyKey":"key-A"}'

Invoke-RestMethod http://localhost:3000/api/listings/PART-100
```

A reservation with a new idempotency key for the same, now sold-out, listing returns `409 INSUFFICIENT_STOCK`. Sending the same request again with the same key returns the original reservation (`replayed: true`) without deducting stock. The release URL is `POST /api/reservations/<id>/release` using the `id` from the reservation response. Browsers can open the `GET` routes (for example `http://localhost:3000/api/listings/PART-100` and `http://localhost:3000/api/events`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ECONNREFUSED ...:5432` or `Migration failed:` | PostgreSQL is not running. Start Docker Desktop, then `docker compose up -d`, then `npm run db:migrate`. |
| `docker ... dockerDesktopLinuxEngine ... cannot find the file` | Docker Desktop is not started. Open it, wait until it says it is running, retry. |
| `EADDRINUSE ... :3000` | Another program is using port 3000. Use another port (see Quick start) or stop that program: `Get-NetTCPConnection -LocalPort 3000` then `Stop-Process -Id <number> -Force`. |
| `ROUTE_NOT_FOUND` | The server is running, but that path does not exist. See the API table above. |
| `npm test` says "no tests" plus a connection error | Same as the first row: the test database is unreachable. |
| `npm audit` warnings after `npm install` | They come from development-tool dependencies (test runner, build tools). They do not affect the service and were not changed for this exercise. |

## Reservation lifecycle

* **ACTIVE** consumes available stock.
* **RELEASED** (explicit release) returns the quantity to available stock.
* **EXPIRED** (expiry processing after `expires_at`) returns the quantity to available stock.

RELEASED and EXPIRED are terminal. A reservation changes state at most once, so stock is returned at most once.

## Inventory invariants

1. Available stock is never negative (DB `CHECK`).
2. Available never exceeds total (DB `CHECK`), so active reservations can never exceed total.
3. Only ACTIVE reservations consume stock.
4. RELEASED / EXPIRED reservations do not consume stock.
5. Reservation creation is atomic with its stock deduction (one transaction).
6. Release / expiry is atomic with its stock restoration (one transaction).
7. Retrying an identical request has no additional effect (unique idempotency key).
8. A reservation is never released or expired twice (row lock + `status = 'ACTIVE'` guard).

`TOTAL STOCK = AVAILABLE STOCK + SUM(ACTIVE RESERVATION QUANTITIES)` is checked from the database by `GET /api/listings/:ref` (`invariantHolds`) and by the `expectInvariant` helper in the tests after almost every scenario.

## Testing

`npm test` runs 64 tests in 5 files against the real PostgreSQL `TEST_DATABASE_URL` database (no mocks, no SQLite, no in-memory store).

Concurrency methodology: concurrent requests are started in the same tick with `Promise.all`; each takes its own connection from the `pg` pool, so the transactions genuinely overlap inside PostgreSQL. Results are verified from the database (counts, sums, invariant), not only from API responses. Scenarios: two buyers for the last 2 units; 25 single-unit requests for 10 units; mixed quantities; 10 identical idempotent requests at once; duplicate release; concurrent expiry sweeps; release racing expiry.

Mapping to the assignment's tests: Test 1-2, 9-10 in `reservation.test.ts`; Test 3 in `concurrency.test.ts`; Test 4-5 in `idempotency.test.ts`; Test 6-8, 11-12 in `release.test.ts`; listing rules and health in `listing.test.ts`.

**Mutation check.** To confirm the concurrency tests can fail, I temporarily replaced the atomic conditional `UPDATE` with a naive "read stock, check in application, write stock" version: all 5 concurrency tests failed (oversold). The real implementation was then restored and passes. This was a one-off manual check; the mutant is not part of the repository.

### Actual results

Recorded in the development sandbox on 2026-11-07, PostgreSQL 16.x, Node 22, from a clean `npm install`, fresh databases and `npm run db:migrate`:

```text
$ npm run typecheck      -> tsc --noEmit, no errors
$ npm test               -> Test Files 5 passed (5) | Tests 64 passed (64)
$ npm run demo           -> "Demo completed successfully." (all assertions passed)
$ npm run build          -> compiled; compiled server started, /health returned ok
Flakiness check: the full suite was run 10 times in a row: 10/10 passed.
```

Verbose output of the final run:

```text
RUN  v2.1.9 /home/claude/pamoja-stock-reservation

 ✓ tests/release.test.ts > Test 6: successful release > releases a 2-unit reservation from stock 5 and restores availability to 5
 ✓ tests/release.test.ts > Test 6: successful release > released stock can be reserved again
 ✓ tests/release.test.ts > Test 7: repeated release > second release is rejected with 409 and stock is unchanged
 ✓ tests/release.test.ts > Test 8: invalid release > unknown reservation id -> 404, no stock modified
 ✓ tests/release.test.ts > Test 8: invalid release > malformed reservation id -> 404 (not a database error)
 ✓ tests/release.test.ts > Test 11: expiry processing > expires a past-due ACTIVE reservation, restores stock exactly once, records an event
 ✓ tests/release.test.ts > Test 11: expiry processing > does not touch reservations that have not expired
 ✓ tests/release.test.ts > Test 11: expiry processing > does not expire a RELEASED reservation (no double restore)
 ✓ tests/release.test.ts > Test 11: expiry processing > releasing an EXPIRED reservation is rejected and does not restore stock again
 ✓ tests/release.test.ts > Test 11: expiry processing > two concurrent expiry sweeps restore stock exactly once
 ✓ tests/release.test.ts > Test 12: concurrent release protection > two simultaneous releases of one reservation restore the quantity once
 ✓ tests/release.test.ts > Test 12: concurrent release protection > 10 simultaneous releases -> exactly one succeeds
 ✓ tests/release.test.ts > Test 12: concurrent release protection > release racing expiry: stock is restored exactly once whichever wins
 ✓ tests/release.test.ts > database-level protections > rejects negative available stock and available > total even for direct SQL
 ✓ tests/release.test.ts > database-level protections > rejects non-positive reservation quantities and unknown statuses at the database
 ✓ tests/reservation.test.ts > Test 1: successful reservation > reserves 2 of 5: ACTIVE, available becomes 3
 ✓ tests/reservation.test.ts > Test 1: successful reservation > applies the configured expiry window (default 15 minutes)
 ✓ tests/reservation.test.ts > Test 1: successful reservation > can retrieve a reservation by id
 ✓ tests/reservation.test.ts > Test 2: insufficient stock > rejects 3 of 2 with 409, stock unchanged, no reservation created
 ✓ tests/reservation.test.ts > Test 2: insufficient stock > records a RESERVATION_REJECTED audit event for the failed attempt
 ✓ tests/reservation.test.ts > Test 2: insufficient stock > allows reserving exactly the remaining stock, then rejects one more
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects zero quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects negative quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects decimal quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects string quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects null quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects boolean quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects array quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects object quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects a missing quantity
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects a missing buyerReference
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects a missing orderReference
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects a missing idempotencyKey
 ✓ tests/reservation.test.ts > Test 9: invalid quantities > rejects a missing listingReference
 ✓ tests/reservation.test.ts > Test 10: unknown listing > returns 404 and creates nothing
 ✓ tests/reservation.test.ts > events endpoint > paginates and never exposes configuration
 ✓ tests/idempotency.test.ts > Test 4: idempotent retry > same key + same parameters returns the original reservation and deducts stock once
 ✓ tests/idempotency.test.ts > Test 4: idempotent retry > a replay still works after the listing is sold out
 ✓ tests/idempotency.test.ts > Test 5: idempotency key reuse with different details > different quantity -> 409 and no extra deduction
 ✓ tests/idempotency.test.ts > Test 5: idempotency key reuse with different details > different listing -> 409 and neither listing is touched
 ✓ tests/idempotency.test.ts > Test 5: idempotency key reuse with different details > different buyer or order reference -> 409
 ✓ tests/idempotency.test.ts > simultaneous requests with the SAME idempotency key > 10 concurrent identical requests -> one reservation, stock deducted once, all return the same id
 ✓ tests/idempotency.test.ts > simultaneous requests with the SAME idempotency key > concurrent duplicates when stock covers only ONE request still replay (not "insufficient stock")
 ✓ tests/idempotency.test.ts > simultaneous requests with the SAME idempotency key > concurrent requests reusing one key with DIFFERENT details: one wins, others get 409
 ✓ tests/idempotency.test.ts > simultaneous requests with the SAME idempotency key > the database unique constraint is the final authority
 ✓ tests/concurrency.test.ts > Test 3: concurrent reservation protection > service level: two concurrent requests for 2 units of a 2-unit listing -> exactly one wins
 ✓ tests/concurrency.test.ts > Test 3: concurrent reservation protection > HTTP level: two concurrent POSTs for 2 units of a 2-unit listing -> one 201, one 409
 ✓ tests/concurrency.test.ts > Test 3: concurrent reservation protection > stress: 25 concurrent single-unit requests against 10 units -> exactly 10 succeed, stock never negative
 ✓ tests/concurrency.test.ts > Test 3: concurrent reservation protection > stress: mixed quantities never exceed total stock
 ✓ tests/concurrency.test.ts > Test 3: concurrent reservation protection > a rejected concurrent request leaves no partial decrement
 ✓ tests/listing.test.ts > health > GET /health reports ok
 ✓ tests/listing.test.ts > listings > creates a listing with available stock equal to total stock
 ✓ tests/listing.test.ts > listings > retrieves listing stock information including the inventory invariant
 ✓ tests/listing.test.ts > listings > rejects negative stock
 ✓ tests/listing.test.ts > listings > rejects invalid input: decimal stock
 ✓ tests/listing.test.ts > listings > rejects invalid input: string stock
 ✓ tests/listing.test.ts > listings > rejects invalid input: missing stock
 ✓ tests/listing.test.ts > listings > rejects invalid input: empty reference
 ✓ tests/listing.test.ts > listings > rejects invalid input: reference with spaces/symbols
 ✓ tests/listing.test.ts > listings > rejects invalid input: reference too long
 ✓ tests/listing.test.ts > listings > rejects invalid input: non-string reference
 ✓ tests/listing.test.ts > listings > prevents duplicate listing references
 ✓ tests/listing.test.ts > listings > returns 404 for an unknown listing
 ✓ tests/listing.test.ts > listings > returns 400 for malformed JSON without leaking internals

 Test Files  5 passed (5)
      Tests  64 passed (64)
   Start at  10:00:48
   Duration  4.52s (transform 250ms, setup 44ms, collect 1.19s, tests 1.70s, environment 1ms, prepare 429ms)
```

### What was NOT verified here

* **Docker / Docker Compose were not run** (no Docker in the sandbox). PostgreSQL 16 was installed natively with apt and a `pamoja` role/databases matching `docker-compose.yml` and `.env.example`. Run `docker compose up -d` on your machine to exercise the compose file and the optional `api` service/`Dockerfile`; if anything differs, please treat it as a bug to fix.
* Overlap of concurrent transactions is produced by parallel pool connections, but exact interleaving cannot be forced from application code. The mutation check above is the evidence that the tests detect races.

## Project layout

```text
src/config        database pool + withTransaction, env, migration runner/CLI
src/modules       listings | reservations | events  (routes -> controller -> service)
src/middleware    Zod validation, error handling
database/         migrations/001_initial_schema.sql, seed.sql, docker-init/
tests/            listing, reservation, concurrency, idempotency, release (+ helpers, global setup)
scripts/demo.ts   reproducible scenario
docs/             TECHNICAL-NOTE.md, DEMO-OUTPUT.md
```

See `docs/TECHNICAL-NOTE.md` for the design explanation, trade-offs, limitations, and decisions PAMOJA must approve before production use.

Notes: the repository's `.env` is never committed. `npm run demo` deletes any existing `PART-001` data in the development database first so it is repeatable. The health response uses the service name `pamoja-stock-reservation` (the assignment text contained a stray space in that name).
