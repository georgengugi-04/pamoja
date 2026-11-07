import { Router } from 'express';
import { validateQuery } from '../../middleware/validation.middleware';
import { eventQuerySchema, list } from './event.controller';

export const eventRouter = Router();
eventRouter.get('/', validateQuery(eventQuerySchema), list);
