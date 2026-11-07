-- Optional sample data for manual exploration (npm run db:seed). Test identifiers only.
INSERT INTO listings (listing_reference, total_stock, available_stock)
VALUES ('SEED-001', 10, 10), ('SEED-002', 3, 3)
ON CONFLICT (listing_reference) DO NOTHING;
