import express from 'express';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { eventRouter } from './modules/events/event.routes';
import { listingRouter } from './modules/listings/listing.routes';
import { reservationRouter } from './modules/reservations/reservation.routes';

export const SERVICE_NAME = 'pamoja-stock-reservation';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

    app.get('/', (_req, res) => {
    res.status(200).json({
      service: SERVICE_NAME,
      status: 'running',
      endpoints: [
        'GET  /health',
        'POST /api/listings',
        'GET  /api/listings/:listingReference',
        'POST /api/reservations',
        'GET  /api/reservations/:reservationId',
        'POST /api/reservations/:reservationId/release',
        'POST /api/reservations/process-expired',
        'GET  /api/events',
      ],
    });
  });

  app.use('/api/listings', listingRouter);
  app.use('/api/reservations', reservationRouter);
  app.use('/api/events', eventRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
