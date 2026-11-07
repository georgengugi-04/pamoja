import type { NextFunction, Request, Response } from 'express';
import { ZodError, ZodTypeAny } from 'zod';
import { badRequest } from '../utils/errors';

function toIssues(err: ZodError) {
  return err.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message }));
}

export const validateBody =
  (schema: ZodTypeAny) => (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(badRequest('VALIDATION_ERROR', 'Invalid request.', toIssues(parsed.error)));
    }
    req.body = parsed.data;
    next();
  };

export const validateQuery =
  (schema: ZodTypeAny) => (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return next(badRequest('VALIDATION_ERROR', 'Invalid query parameters.', toIssues(parsed.error)));
    }
    res.locals.query = parsed.data;
    next();
  };
