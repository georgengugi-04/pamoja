import { Router } from 'express';
import { validateBody } from '../../middleware/validation.middleware';
import { create, createListingSchema, retrieve } from './listing.controller';

export const listingRouter = Router();
listingRouter.post('/', validateBody(createListingSchema), create);
listingRouter.get('/:listingReference', retrieve);
