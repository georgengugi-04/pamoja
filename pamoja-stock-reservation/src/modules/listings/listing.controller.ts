import { z } from 'zod';
import { asyncHandler } from '../../utils/async-handler';
import { listingReferenceSchema } from '../reservations/reservation.types';
import { createListing, getListing } from './listing.service';

export const createListingSchema = z.object({
  listingReference: listingReferenceSchema,
  totalStock: z
    .number({ invalid_type_error: 'must be a number', required_error: 'is required' })
    .int('must be an integer')
    .min(0, 'must not be negative')
    .max(1_000_000, 'is unreasonably large'),
});

export const create = asyncHandler(async (req, res) => {
  const { listingReference, totalStock } = req.body as z.infer<typeof createListingSchema>;
  const listing = await createListing(listingReference, totalStock);
  res.status(201).json({ success: true, listing });
});

export const retrieve = asyncHandler(async (req, res) => {
  const ref = String(req.params.listingReference);
  const parsed = listingReferenceSchema.safeParse(ref);
  if (!parsed.success) {
    res.status(404).json({
      success: false,
      error: { code: 'LISTING_NOT_FOUND', message: `Listing "${ref.slice(0, 80)}" was not found.` },
    });
    return;
  }
  res.status(200).json({ success: true, listing: await getListing(ref) });
});
