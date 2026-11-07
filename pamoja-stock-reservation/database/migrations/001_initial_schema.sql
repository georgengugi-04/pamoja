-- PAMOJA stock reservation prototype: initial schema.
-- PostgreSQL is the source of truth for inventory. All invariants that can be
-- enforced by the database are enforced here, not only in application code.

CREATE TABLE listings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_reference TEXT        NOT NULL,
  total_stock       INTEGER     NOT NULL,
  available_stock   INTEGER     NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT listings_listing_reference_key       UNIQUE (listing_reference),
  CONSTRAINT listings_reference_format            CHECK (listing_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT listings_total_stock_non_negative    CHECK (total_stock >= 0),
  CONSTRAINT listings_available_non_negative      CHECK (available_stock >= 0),
  CONSTRAINT listings_available_not_above_total   CHECK (available_stock <= total_stock)
);

CREATE TABLE reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID        NOT NULL REFERENCES listings (id),
  buyer_reference TEXT        NOT NULL,
  order_reference TEXT        NOT NULL,
  idempotency_key TEXT        NOT NULL,
  quantity        INTEGER     NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'ACTIVE',
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The database is the final authority on idempotency (see reservation.service.ts).
  CONSTRAINT reservations_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT reservations_quantity_positive   CHECK (quantity > 0),
  CONSTRAINT reservations_status_valid        CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED'))
);

CREATE INDEX reservations_active_expiry_idx   ON reservations (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX reservations_listing_status_idx  ON reservations (listing_id, status);

CREATE TABLE reservation_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            BIGSERIAL   NOT NULL,           -- deterministic ordering for pagination
  reservation_id UUID        REFERENCES reservations (id) ON DELETE SET NULL,
  listing_id     UUID        REFERENCES listings (id)     ON DELETE SET NULL,
  event_type     TEXT        NOT NULL,
  event_details  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reservation_events_type_valid CHECK (event_type IN (
    'LISTING_CREATED', 'RESERVATION_REQUESTED', 'RESERVATION_CREATED',
    'RESERVATION_REJECTED', 'RESERVATION_RELEASED', 'RESERVATION_EXPIRED',
    'IDEMPOTENT_REPLAY'
  ))
);

CREATE INDEX reservation_events_seq_idx         ON reservation_events (seq DESC);
CREATE INDEX reservation_events_reservation_idx ON reservation_events (reservation_id);
CREATE INDEX reservation_events_listing_idx     ON reservation_events (listing_id);
