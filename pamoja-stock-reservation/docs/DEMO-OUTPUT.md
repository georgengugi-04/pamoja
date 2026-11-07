# Demo output (captured from a real run)

Produced by `npm run demo` against PostgreSQL 16. Reservation ids and timestamps differ per run; which buyer wins the race can differ too, but exactly one always does.

```text
> pamoja-stock-reservation@1.0.0 demo
> tsx scripts/demo.ts

PAMOJA stock reservation demo -> http://127.0.0.1:33185

### 0. Health check
> GET /health
< HTTP 200
{
  "status": "ok",
  "service": "pamoja-stock-reservation"
}

### 1. Create listing PART-001 with stock 2
> POST /api/listings
{
  "listingReference": "PART-001",
  "totalStock": 2
}
< HTTP 201
{
  "success": true,
  "listing": {
    "listingReference": "PART-001",
    "totalStock": 2,
    "availableStock": 2
  }
}
   ✔ listing created with 2 units

### 2-3. Buyer A and Buyer B request 2 units each, CONCURRENTLY (Promise.all)
Buyer A -> HTTP 201
{
  "success": true,
  "replayed": false,
  "reservation": {
    "id": "77877064-2ada-4248-90a2-a5e64a5b9dbf",
    "listingReference": "PART-001",
    "buyerReference": "BUYER-A",
    "orderReference": "ORDER-A",
    "idempotencyKey": "demo-reserve-A",
    "quantity": 2,
    "status": "ACTIVE",
    "expiresAt": "2026-11-07T10:15:54.023Z",
    "createdAt": "2026-11-07T10:00:54.023Z",
    "updatedAt": "2026-11-07T10:00:54.023Z"
  }
}
Buyer B -> HTTP 409
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Insufficient available stock on listing \"PART-001\" for quantity 2."
  }
}

(The database decided the race: Buyer A won this run. Which buyer wins can vary between runs; exactly one always does.)
   ✔ exactly one request succeeded (201) and one was rejected (409)
   ✔ Buyer A's reservation is ACTIVE
   ✔ Buyer B rejected: INSUFFICIENT_STOCK

### 4. Listing stock after the race
> GET /api/listings/PART-001
< HTTP 200
{
  "success": true,
  "listing": {
    "listingReference": "PART-001",
    "totalStock": 2,
    "availableStock": 0,
    "activeReservedStock": 2,
    "invariantHolds": true,
    "createdAt": "2026-11-07T10:00:54.009Z",
    "updatedAt": "2026-11-07T10:00:54.023Z"
  }
}
   ✔ available stock is 0
   ✔ invariant: total (2) = available (0) + active reserved (2)

### 5. Idempotent retry of Buyer A's request (same key, same parameters)
> POST /api/reservations
{
  "listingReference": "PART-001",
  "quantity": 2,
  "buyerReference": "BUYER-A",
  "orderReference": "ORDER-A",
  "idempotencyKey": "demo-reserve-A"
}
< HTTP 200
{
  "success": true,
  "replayed": true,
  "reservation": {
    "id": "77877064-2ada-4248-90a2-a5e64a5b9dbf",
    "listingReference": "PART-001",
    "buyerReference": "BUYER-A",
    "orderReference": "ORDER-A",
    "idempotencyKey": "demo-reserve-A",
    "quantity": 2,
    "status": "ACTIVE",
    "expiresAt": "2026-11-07T10:15:54.023Z",
    "createdAt": "2026-11-07T10:00:54.023Z",
    "updatedAt": "2026-11-07T10:00:54.023Z"
  }
}
   ✔ replay returns the original reservation (HTTP 200)
   ✔ same reservation id, stock not deducted again

### 6. Release Buyer A's reservation
> POST /api/reservations/77877064-2ada-4248-90a2-a5e64a5b9dbf/release
< HTTP 200
{
  "success": true,
  "reservation": {
    "id": "77877064-2ada-4248-90a2-a5e64a5b9dbf",
    "listingReference": "PART-001",
    "buyerReference": "BUYER-A",
    "orderReference": "ORDER-A",
    "idempotencyKey": "demo-reserve-A",
    "quantity": 2,
    "status": "RELEASED",
    "expiresAt": "2026-11-07T10:15:54.023Z",
    "createdAt": "2026-11-07T10:00:54.023Z",
    "updatedAt": "2026-11-07T10:00:54.090Z"
  }
}
   ✔ reservation is RELEASED

### 7. Listing stock after release
> GET /api/listings/PART-001
< HTTP 200
{
  "success": true,
  "listing": {
    "listingReference": "PART-001",
    "totalStock": 2,
    "availableStock": 2,
    "activeReservedStock": 0,
    "invariantHolds": true,
    "createdAt": "2026-11-07T10:00:54.009Z",
    "updatedAt": "2026-11-07T10:00:54.090Z"
  }
}
   ✔ available stock restored to 2
   ✔ invariant holds: total (2) = available (2) + active reserved (0)

### 8. Repeated release is rejected and does not restore stock twice
> POST /api/reservations/77877064-2ada-4248-90a2-a5e64a5b9dbf/release
< HTTP 409
{
  "success": false,
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "Reservation is RELEASED; only ACTIVE reservations can be released.",
    "details": {
      "currentStatus": "RELEASED"
    }
  }
}
   ✔ second release rejected with 409

###    Listing stock after the rejected second release
> GET /api/listings/PART-001
< HTTP 200
{
  "success": true,
  "listing": {
    "listingReference": "PART-001",
    "totalStock": 2,
    "availableStock": 2,
    "activeReservedStock": 0,
    "invariantHolds": true,
    "createdAt": "2026-11-07T10:00:54.009Z",
    "updatedAt": "2026-11-07T10:00:54.090Z"
  }
}
   ✔ available stock still 2 (not 4)

### 9. Audit trail for PART-001
> GET /api/events?listingReference=PART-001&limit=20
< HTTP 200
{
  "success": true,
  "events": [
    {
      "id": "45e1bb71-5756-4ff8-a421-074c346c18f5",
      "reservationId": "77877064-2ada-4248-90a2-a5e64a5b9dbf",
      "listingId": "d6f85c3c-0867-488d-87c9-c003d5604d63",
      "listingReference": "PART-001",
      "eventType": "RESERVATION_RELEASED",
      "eventDetails": {
        "quantityRestored": 2,
        "availableStockAfter": 2
      },
      "createdAt": "2026-11-07T10:00:54.096Z"
    },
    {
      "id": "8b7d08ed-099b-4b43-b99e-854a8da1c1c9",
      "reservationId": "77877064-2ada-4248-90a2-a5e64a5b9dbf",
      "listingId": "d6f85c3c-0867-488d-87c9-c003d5604d63",
      "listingReference": "PART-001",
      "eventType": "IDEMPOTENT_REPLAY",
      "eventDetails": {
        "via": "lookup",
        "quantity": 2,
        "idempotencyKey": "demo-reserve-A"
      },
      "createdAt": "2026-11-07T10:00:54.079Z"
    },
    {
      "id": "90b19477-9aca-4ae1-a76e-99e0470e70fd",
      "reservationId": null,
      "listingId": "d6f85c3c-0867-488d-87c9-c003d5604d63",
      "listingReference": "PART-001",
      "eventType": "RESERVATION_REJECTED",
      "eventDetails": {
        "reason": "INSUFFICIENT_STOCK",
        "quantity": 2,
        "idempotencyKey": "demo-reserve-B"
      },
      "createdAt": "2026-11-07T10:00:54.054Z"
    },
    {
      "id": "a2db3f47-a591-4a68-9daf-a65a92131f2d",
      "reservationId": null,
      "listingId": "d6f85c3c-0867-488d-87c9-c003d5604d63",
      "listingReference": "PART-001",
      "eventType": "RESERVATION_REQUESTED",
      "eventDetails": {
        "quantity": 2,
        "idempotencyKey": "demo-reserve-B"
      },
      "createdAt": "2026-11-07T10:00:54.052Z"
    },
    {
      "id": "2a3b96bb-f05c-4739-86c4-5251ec0077d1",
      "reservationId": "77877064-2ada-4248-90a2-a5e64a5b9dbf",
      "listingId": "d6f85c3c-0867-488d-87c9-c003d5604d63",
      "listingReference": "PART-001",
      "eventType": "RESERVATION_CREATED",
      "eventDetails": {
        "quantity": 2,
        "expiresAt": "2026-11-07T10:15:54.023Z",
        "availableStockAfter": 0
      },
      "createdAt": "2026-11-07T10:00:54.035Z"
    },
    {
      "id": "9cdd6fa2-4d80-43e9-9da9-2139effbec45",
      "reservationId": "77877064-2ada-4248-90a2-a5e64a5b9dbf",
      "listingId": "d6f85c3c-0867-488d-87c9-c003d5604d63",
      "listingReference": "PART-001",
      "eventType": "RESERVATION_REQUESTED",
      "eventDetails": {
        "quantity": 2,
        "idempotencyKey": "demo-reserve-A"
      },
      "createdAt": "2026-11-07T10:00:54.035Z"
    },
    {
      "id": "c135a62e-b33a-495d-a38c-0054375195dd",
      "reservationId": null,
      "listingId": "d6f85c3c-0867-488d-87c9-c003d5604d63",
      "listingReference": "PART-001",
      "eventType": "LISTING_CREATED",
      "eventDetails": {
        "totalStock": 2,
        "listingReference": "PART-001"
      },
      "createdAt": "2026-11-07T10:00:54.013Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 7
  }
}

Demo completed successfully.
```
