import { pool, Queryable, withTransaction } from '../../config/database';
import { reservationTtlMinutes } from '../../config/env';
import { AppError, conflict, isUniqueViolation, isUuid, notFound } from '../../utils/errors';
import { recordAuditEvent, recordEvent } from '../events/event.service';
import type { CreateReservationInput, ReservationDto } from './reservation.types';

const IDEMPOTENCY_CONSTRAINT = 'reservations_idempotency_key_key';

interface ReservationRow {
  id: string;
  listing_id: string;
  listing_reference: string;
  buyer_reference: string;
  order_reference: string;
  idempotency_key: string;
  quantity: number;
  status: 'ACTIVE' | 'RELEASED' | 'EXPIRED';
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

const SELECT_RESERVATION = `
  SELECT r.id, r.listing_id, l.listing_reference, r.buyer_reference, r.order_reference,
         r.idempotency_key, r.quantity, r.status, r.expires_at, r.created_at, r.updated_at
  FROM reservations r
  JOIN listings l ON l.id = r.listing_id`;

function toDto(r: ReservationRow): ReservationDto {
  return {
    id: r.id,
    listingReference: r.listing_reference,
    buyerReference: r.buyer_reference,
    orderReference: r.order_reference,
    idempotencyKey: r.idempotency_key,
    quantity: r.quantity,
    status: r.status,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

async function findByIdempotencyKey(db: Queryable, key: string): Promise<ReservationRow | undefined> {
  const res = await db.query<ReservationRow>(`${SELECT_RESERVATION} WHERE r.idempotency_key = $1`, [key]);
  return res.rows[0];
}

/** Same logical request = same listing, quantity, buyer and order. */
function sameLogicalRequest(existing: ReservationRow, input: CreateReservationInput): boolean {
  return (
    existing.listing_reference === input.listingReference &&
    existing.quantity === input.quantity &&
    existing.buyer_reference === input.buyerReference &&
    existing.order_reference === input.orderReference
  );
}

const idempotencyConflict = () =>
  conflict(
    'IDEMPOTENCY_KEY_REUSED',
    'This idempotency key was already used for a different logical operation. Use a new key for a new request.',
  );

const insufficientStock = (ref: string, quantity: number) =>
  conflict('INSUFFICIENT_STOCK', `Insufficient available stock on listing "${ref}" for quantity ${quantity}.`);

export interface CreateReservationResult {
  reservation: ReservationDto;
  replayed: boolean;
}

/**
 * Reserves stock. Everything that changes inventory happens in ONE transaction:
 *  idempotency lookup -> listing check -> atomic conditional decrement -> reservation insert -> events.
 */
export async function createReservation(input: CreateReservationInput): Promise<CreateReservationResult> {
  try {
    return await withTransaction((c) => attemptCreate(c, input));
  } catch (err) {
    // The transaction has been rolled back: no stock was taken, no reservation exists from this attempt.
    let outcome: unknown = err;

    // Two situations can hide an earlier/concurrent success for the same key:
    //  - the unique constraint fired because a concurrent request with the same key committed first;
    //  - the concurrent winner consumed the last stock, so our decrement found none.
    // In both cases the committed reservation is the truth, so look it up in a fresh read.
    if (isUniqueViolation(err, IDEMPOTENCY_CONSTRAINT) || (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK')) {
      const existing = await findByIdempotencyKey(pool, input.idempotencyKey);
      if (existing) {
        if (sameLogicalRequest(existing, input)) {
          await recordAuditEvent({
            eventType: 'IDEMPOTENT_REPLAY',
            reservationId: existing.id,
            listingId: existing.listing_id,
            details: { idempotencyKey: input.idempotencyKey, quantity: existing.quantity, via: 'concurrent-duplicate' },
          });
          return { reservation: toDto(existing), replayed: true };
        }
        outcome = idempotencyConflict();
      }
    }

    if (outcome instanceof AppError) {
      // Audit in a separate transaction so the rejection is recorded without touching inventory.
      await recordAuditEvent({
        eventType: 'RESERVATION_REQUESTED',
        listingReference: input.listingReference,
        details: { idempotencyKey: input.idempotencyKey, quantity: input.quantity },
      });
      await recordAuditEvent({
        eventType: 'RESERVATION_REJECTED',
        listingReference: input.listingReference,
        details: {
          reason: outcome.code,
          idempotencyKey: input.idempotencyKey,
          quantity: input.quantity,
        },
      });
    }
    throw outcome;
  }
}

async function attemptCreate(
  c: Queryable,
  input: CreateReservationInput,
): Promise<CreateReservationResult> {
  // Step 3-6: idempotency check.
  const existing = await findByIdempotencyKey(c, input.idempotencyKey);
  if (existing) {
    if (!sameLogicalRequest(existing, input)) throw idempotencyConflict();
    await recordEvent(c, {
      eventType: 'IDEMPOTENT_REPLAY',
      reservationId: existing.id,
      listingId: existing.listing_id,
      details: { idempotencyKey: input.idempotencyKey, quantity: existing.quantity, via: 'lookup' },
    });
    return { reservation: toDto(existing), replayed: true };
  }

  // Step 7: listing must exist.
  const listing = await c.query<{ id: string }>('SELECT id FROM listings WHERE listing_reference = $1', [
    input.listingReference,
  ]);
  if (listing.rowCount === 0) {
    throw notFound('LISTING_NOT_FOUND', `Listing "${input.listingReference}" was not found.`);
  }
  const listingId = listing.rows[0].id;

  // Step 8: atomic conditional decrement. The WHERE clause is the oversell guard; the row lock
  // taken by UPDATE makes a competing transaction wait, then re-evaluate against the new value.
  const dec = await c.query(
    `UPDATE listings
        SET available_stock = available_stock - $1, updated_at = NOW()
      WHERE id = $2 AND available_stock >= $1
      RETURNING id, available_stock`,
    [input.quantity, listingId],
  );

  // Step 9: no row => not enough stock (re-check existence to give the right error).
  if (dec.rowCount === 0) {
    const still = await c.query('SELECT 1 FROM listings WHERE id = $1', [listingId]);
    if (still.rowCount === 0) {
      throw notFound('LISTING_NOT_FOUND', `Listing "${input.listingReference}" was not found.`);
    }
    throw insufficientStock(input.listingReference, input.quantity);
  }

  // Step 10: reservation row. A duplicate idempotency key raises 23505 here; the caller rolls back
  // (restoring the decrement above) and returns the original reservation.
  const ins = await c.query<Omit<ReservationRow, 'listing_reference'>>(
    `INSERT INTO reservations
       (listing_id, buyer_reference, order_reference, idempotency_key, quantity, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW() + ($6::double precision * INTERVAL '1 minute'))
     RETURNING id, listing_id, buyer_reference, order_reference, idempotency_key, quantity, status,
               expires_at, created_at, updated_at`,
    [
      listingId,
      input.buyerReference,
      input.orderReference,
      input.idempotencyKey,
      input.quantity,
      reservationTtlMinutes(),
    ],
  );
  const row: ReservationRow = { ...ins.rows[0], listing_reference: input.listingReference };

  // Step 11: events, in the same transaction.
  await recordEvent(c, {
    eventType: 'RESERVATION_REQUESTED',
    reservationId: row.id,
    listingId,
    details: { idempotencyKey: input.idempotencyKey, quantity: input.quantity },
  });
  await recordEvent(c, {
    eventType: 'RESERVATION_CREATED',
    reservationId: row.id,
    listingId,
    details: {
      quantity: input.quantity,
      availableStockAfter: dec.rows[0].available_stock,
      expiresAt: row.expires_at.toISOString(),
    },
  });

  return { reservation: toDto(row), replayed: false };
}

export async function getReservation(id: string): Promise<ReservationDto> {
  if (!isUuid(id)) throw notFound('RESERVATION_NOT_FOUND', 'Reservation was not found.');
  const res = await pool.query<ReservationRow>(`${SELECT_RESERVATION} WHERE r.id = $1`, [id]);
  if (res.rowCount === 0) throw notFound('RESERVATION_NOT_FOUND', 'Reservation was not found.');
  return toDto(res.rows[0]);
}

/**
 * Releases an ACTIVE reservation and returns its quantity to the listing, atomically.
 * The row lock (FOR UPDATE) serialises concurrent release/expiry attempts on the same reservation:
 * the loser waits, then sees a non-ACTIVE status and is rejected without touching stock.
 */
export async function releaseReservation(id: string): Promise<ReservationDto> {
  if (!isUuid(id)) throw notFound('RESERVATION_NOT_FOUND', 'Reservation was not found.');

  return withTransaction(async (c) => {
    const found = await c.query<ReservationRow>(
      `${SELECT_RESERVATION} WHERE r.id = $1 FOR UPDATE OF r`,
      [id],
    );
    if (found.rowCount === 0) throw notFound('RESERVATION_NOT_FOUND', 'Reservation was not found.');
    const current = found.rows[0];

    if (current.status !== 'ACTIVE') {
      throw conflict(
        'INVALID_STATE_TRANSITION',
        `Reservation is ${current.status}; only ACTIVE reservations can be released.`,
        { currentStatus: current.status },
      );
    }

    const upd = await c.query(
      `UPDATE reservations SET status = 'RELEASED', updated_at = NOW()
        WHERE id = $1 AND status = 'ACTIVE'
        RETURNING updated_at`,
      [id],
    );
    if (upd.rowCount === 0) {
      throw conflict('INVALID_STATE_TRANSITION', 'Reservation is no longer ACTIVE.');
    }

    const restored = await c.query(
      `UPDATE listings SET available_stock = available_stock + $1, updated_at = NOW()
        WHERE id = $2
        RETURNING available_stock`,
      [current.quantity, current.listing_id],
    );

    await recordEvent(c, {
      eventType: 'RESERVATION_RELEASED',
      reservationId: id,
      listingId: current.listing_id,
      details: { quantityRestored: current.quantity, availableStockAfter: restored.rows[0].available_stock },
    });

    return toDto({ ...current, status: 'RELEASED', updated_at: upd.rows[0].updated_at });
  });
}

export interface ExpiryResult {
  expiredCount: number;
  reservationIds: string[];
}

/**
 * Expires ACTIVE reservations whose expires_at has passed and returns their stock.
 * Rows are claimed with FOR UPDATE SKIP LOCKED, so concurrent sweepers never process the same
 * reservation and a reservation being released at that moment is skipped, not double-restored.
 * Processed in batches; each batch is one transaction.
 */
export async function processExpiredReservations(batchSize = 200): Promise<ExpiryResult> {
  const reservationIds: string[] = [];
  for (;;) {
    const batch = await withTransaction(async (c) => {
      const due = await c.query<{ id: string; listing_id: string; quantity: number }>(
        `SELECT id, listing_id, quantity
           FROM reservations
          WHERE status = 'ACTIVE' AND expires_at <= NOW()
          ORDER BY listing_id, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      const ids: string[] = [];
      for (const r of due.rows) {
        const upd = await c.query(
          `UPDATE reservations SET status = 'EXPIRED', updated_at = NOW()
            WHERE id = $1 AND status = 'ACTIVE'`,
          [r.id],
        );
        if (upd.rowCount === 0) continue; // defensive: never restore stock unless we changed the state
        const restored = await c.query(
          `UPDATE listings SET available_stock = available_stock + $1, updated_at = NOW()
            WHERE id = $2 RETURNING available_stock`,
          [r.quantity, r.listing_id],
        );
        await recordEvent(c, {
          eventType: 'RESERVATION_EXPIRED',
          reservationId: r.id,
          listingId: r.listing_id,
          details: { quantityRestored: r.quantity, availableStockAfter: restored.rows[0].available_stock },
        });
        ids.push(r.id);
      }
      return { ids, fetched: due.rows.length };
    });
    reservationIds.push(...batch.ids);
    if (batch.fetched < batchSize) break;
  }
  return { expiredCount: reservationIds.length, reservationIds };
}
