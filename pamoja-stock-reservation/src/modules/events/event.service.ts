import { pool, Queryable } from '../../config/database';

export type EventType =
  | 'LISTING_CREATED'
  | 'RESERVATION_REQUESTED'
  | 'RESERVATION_CREATED'
  | 'RESERVATION_REJECTED'
  | 'RESERVATION_RELEASED'
  | 'RESERVATION_EXPIRED'
  | 'IDEMPOTENT_REPLAY';

export const EVENT_TYPES = [
  'LISTING_CREATED',
  'RESERVATION_REQUESTED',
  'RESERVATION_CREATED',
  'RESERVATION_REJECTED',
  'RESERVATION_RELEASED',
  'RESERVATION_EXPIRED',
  'IDEMPOTENT_REPLAY',
] as const;

export interface NewEvent {
  eventType: EventType;
  reservationId?: string | null;
  listingId?: string | null;
  /** Used to resolve listing_id when only the human reference is known (e.g. rejected requests). */
  listingReference?: string;
  /** Never put personal data, credentials or stack traces in here. */
  details?: Record<string, unknown>;
}

/** Records an event using the supplied connection, so it joins the caller's transaction. */
export async function recordEvent(db: Queryable, e: NewEvent): Promise<void> {
  await db.query(
    `INSERT INTO reservation_events (reservation_id, listing_id, event_type, event_details)
     VALUES ($1,
             COALESCE($2::uuid, (SELECT id FROM listings WHERE listing_reference = $3)),
             $4,
             $5::jsonb)`,
    [
      e.reservationId ?? null,
      e.listingId ?? null,
      e.listingReference ?? null,
      e.eventType,
      JSON.stringify(e.details ?? {}),
    ],
  );
}

/**
 * Records an event in its OWN transaction (pool autocommit). Used for outcomes whose main
 * transaction rolled back (rejections) so the audit trail survives without touching inventory.
 * An audit failure must never mask or alter the original outcome.
 */
export async function recordAuditEvent(e: NewEvent): Promise<void> {
  try {
    await recordEvent(pool, e);
  } catch (err) {
    console.error('audit event failed:', (err as Error).message);
  }
}

export interface EventQuery {
  limit: number;
  offset: number;
  eventType?: EventType;
  listingReference?: string;
  reservationId?: string;
}

export async function listEvents(q: EventQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.eventType) {
    params.push(q.eventType);
    where.push(`e.event_type = $${params.length}`);
  }
  if (q.listingReference) {
    params.push(q.listingReference);
    where.push(`l.listing_reference = $${params.length}`);
  }
  if (q.reservationId) {
    params.push(q.reservationId);
    where.push(`e.reservation_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM reservation_events e LEFT JOIN listings l ON l.id = e.listing_id ${whereSql}`;

  const total = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n ${from}`, params);
  const rows = await pool.query(
    `SELECT e.id, e.reservation_id, e.listing_id, l.listing_reference, e.event_type,
            e.event_details, e.created_at
     ${from}
     ORDER BY e.seq DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.limit, q.offset],
  );

  return {
    events: rows.rows.map((r) => ({
      id: r.id as string,
      reservationId: r.reservation_id as string | null,
      listingId: r.listing_id as string | null,
      listingReference: r.listing_reference as string | null,
      eventType: r.event_type as EventType,
      eventDetails: r.event_details as Record<string, unknown>,
      createdAt: (r.created_at as Date).toISOString(),
    })),
    pagination: { limit: q.limit, offset: q.offset, total: Number(total.rows[0].n) },
  };
}
