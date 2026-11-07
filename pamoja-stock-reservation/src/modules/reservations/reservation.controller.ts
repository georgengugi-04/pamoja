import { asyncHandler } from '../../utils/async-handler';
import {
  createReservation,
  getReservation,
  processExpiredReservations,
  releaseReservation,
} from './reservation.service';
import type { CreateReservationInput } from './reservation.types';

export const create = asyncHandler(async (req, res) => {
  const result = await createReservation(req.body as CreateReservationInput);
  // 201 for a newly created reservation, 200 for an idempotent replay of an earlier one.
  res.status(result.replayed ? 200 : 201).json({
    success: true,
    replayed: result.replayed,
    reservation: result.reservation,
  });
});

export const retrieve = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, reservation: await getReservation(String(req.params.reservationId)) });
});

export const release = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, reservation: await releaseReservation(String(req.params.reservationId)) });
});

export const processExpired = asyncHandler(async (_req, res) => {
  const result = await processExpiredReservations();
  res.status(200).json({ success: true, ...result });
});
