import { pool, withTransaction } from '../../config/database';
import { conflict, isUniqueViolation, notFound } from '../../utils/errors';
import { recordEvent } from '../events/event.service';

export interface ListingDto {
  listingReference: string;
  totalStock: number;
  availableStock: number;
}

export interface ListingDetailDto extends ListingDto {
  activeReservedStock: number;
  /** TOTAL STOCK = AVAILABLE STOCK + SUM(ACTIVE RESERVATION QUANTITIES) */
  invariantHolds: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function createListing(listingReference: string, totalStock: number): Promise<ListingDto> {
  try {
    return await withTransaction(async (c) => {
      const res = await c.query(
        `INSERT INTO listings (listing_reference, total_stock, available_stock)
         VALUES ($1, $2, $2)
         RETURNING id, listing_reference, total_stock, available_stock`,
        [listingReference, totalStock],
      );
      const row = res.rows[0];
      await recordEvent(c, {
        eventType: 'LISTING_CREATED',
        listingId: row.id,
        details: { listingReference, totalStock },
      });
      return {
        listingReference: row.listing_reference,
        totalStock: row.total_stock,
        availableStock: row.available_stock,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'listings_listing_reference_key')) {
      throw conflict('DUPLICATE_LISTING', `Listing "${listingReference}" already exists.`);
    }
    throw err;
  }
}

export async function getListing(listingReference: string): Promise<ListingDetailDto> {
  // One statement = one snapshot, so the invariant is evaluated consistently.
  const res = await pool.query(
    `SELECT l.listing_reference, l.total_stock, l.available_stock, l.created_at, l.updated_at,
            COALESCE((SELECT SUM(r.quantity) FROM reservations r
                      WHERE r.listing_id = l.id AND r.status = 'ACTIVE'), 0)::int AS active_reserved
     FROM listings l
     WHERE l.listing_reference = $1`,
    [listingReference],
  );
  if (res.rowCount === 0) throw notFound('LISTING_NOT_FOUND', `Listing "${listingReference}" was not found.`);
  const r = res.rows[0];
  return {
    listingReference: r.listing_reference,
    totalStock: r.total_stock,
    availableStock: r.available_stock,
    activeReservedStock: r.active_reserved,
    invariantHolds: r.total_stock === r.available_stock + r.active_reserved,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
