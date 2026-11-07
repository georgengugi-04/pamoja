import { afterAll, describe, expect, it } from 'vitest';
import { app, makeListing, pool, request, uniq } from './helpers';

afterAll(() => pool.end());

describe('health', () => {
  it('GET /health reports ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'pamoja-stock-reservation' });
  });
});

describe('listings', () => {
  it('creates a listing with available stock equal to total stock', async () => {
    const listingReference = uniq('PART');
    const res = await request(app).post('/api/listings').send({ listingReference, totalStock: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      listing: { listingReference, totalStock: 2, availableStock: 2 },
    });
  });

  it('retrieves listing stock information including the inventory invariant', async () => {
    const ref = await makeListing(7);
    const res = await request(app).get(`/api/listings/${ref}`);
    expect(res.status).toBe(200);
    expect(res.body.listing).toMatchObject({
      listingReference: ref,
      totalStock: 7,
      availableStock: 7,
      activeReservedStock: 0,
      invariantHolds: true,
    });
  });

  it('rejects negative stock', async () => {
    const res = await request(app).post('/api/listings').send({ listingReference: uniq('PART'), totalStock: -1 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it.each([
    ['decimal stock', { totalStock: 1.5 }],
    ['string stock', { totalStock: '3' }],
    ['missing stock', { totalStock: undefined }],
    ['empty reference', { listingReference: '', totalStock: 1 }],
    ['reference with spaces/symbols', { listingReference: 'bad ref!', totalStock: 1 }],
    ['reference too long', { listingReference: 'A'.repeat(65), totalStock: 1 }],
    ['non-string reference', { listingReference: 123, totalStock: 1 }],
  ])('rejects invalid input: %s', async (_name, patch) => {
    const body: Record<string, unknown> = Object.assign({ listingReference: uniq('PART'), totalStock: 1 }, patch);
    const res = await request(app).post('/api/listings').send(body);
    expect(res.status).toBe(400);
  });

  it('prevents duplicate listing references', async () => {
    const ref = await makeListing(1);
    const res = await request(app).post('/api/listings').send({ listingReference: ref, totalStock: 9 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_LISTING');
    const check = await request(app).get(`/api/listings/${ref}`);
    expect(check.body.listing.totalStock).toBe(1); // original untouched
  });

  it('returns 404 for an unknown listing', async () => {
    const res = await request(app).get('/api/listings/DOES-NOT-EXIST');
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed JSON without leaking internals', async () => {
    const res = await request(app).post('/api/listings').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|SyntaxError/i);
  });
});
