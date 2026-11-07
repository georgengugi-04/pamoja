import { z } from 'zod';

const reference = z.string().trim().min(1).max(128);

export const listingReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'must be 1-64 chars: letters, digits, "-" or "_", starting with a letter or digit');

export const createReservationSchema = z.object({
  listingReference: listingReferenceSchema,
  quantity: z.number({ invalid_type_error: 'must be a number', required_error: 'is required' }).int('must be an integer').positive('must be greater than zero'),
  buyerReference: reference,
  orderReference: reference,
  idempotencyKey: z.string().trim().min(1).max(200),
});

export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export type ReservationStatus = 'ACTIVE' | 'RELEASED' | 'EXPIRED';

export interface ReservationDto {
  id: string;
  listingReference: string;
  buyerReference: string;
  orderReference: string;
  idempotencyKey: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
