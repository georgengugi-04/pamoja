import { Router } from 'express';
import { validateBody } from '../../middleware/validation.middleware';
import { create, processExpired, release, retrieve } from './reservation.controller';
import { createReservationSchema } from './reservation.types';

export const reservationRouter = Router();
reservationRouter.post('/', validateBody(createReservationSchema), create);
// Fixed path registered before the parameterised routes for clarity.
reservationRouter.post('/process-expired', processExpired);
reservationRouter.get('/:reservationId', retrieve);
reservationRouter.post('/:reservationId/release', release);
