import { z } from 'zod';
import { asyncHandler } from '../../utils/async-handler';
import { EVENT_TYPES, listEvents } from './event.service';

export const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  eventType: z.enum(EVENT_TYPES).optional(),
  listingReference: z.string().max(64).optional(),
  reservationId: z.string().uuid().optional(),
});

export const list = asyncHandler(async (_req, res) => {
  const result = await listEvents(res.locals.query as z.infer<typeof eventQuerySchema>);
  res.status(200).json({ success: true, ...result });
});
