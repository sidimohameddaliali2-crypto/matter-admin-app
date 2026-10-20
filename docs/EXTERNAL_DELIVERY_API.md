# External delivery API

A read-only API for handing delivery data to an outside party (a logistics
partner, a kitchen system, etc.) **without** creating them a login in this
app. Every delivery includes the assigned driver's details and the
customer's current meal count, so the consumer never needs a second call.

Auth is a static **API key** (header, not a JWT login) — see
`server/middleware/apiKeyAuth.js`.

## 1. Issue a key

Pick any random string, e.g.:

```bash
openssl rand -hex 24
```

Add it to the server `.env` (then `pm2 restart matter-d`):

```
DELIVERY_API_KEYS=partner_name:9f2a3c7e5b1d...
```

- Format is `label:key`, comma-separated for multiple partners:
  ```
  DELIVERY_API_KEYS=acme_logistics:9f2a3c...,kitchen_system:7c1b90...
  ```
- A bare key with no `label:` prefix also works (labelled `default`).
- To revoke a partner, delete their entry and restart — no DB record to clean up.

Give the partner: the base URL (`https://matterapp.online/api/external/deliveries` —
or your API host) and their key. Nothing else.

## 2. What they call

Send the key as either header:

```
x-api-key: 9f2a3c7e5b1d...
```
or
```
Authorization: Bearer 9f2a3c7e5b1d...
```

### `GET /api/external/deliveries`

List deliveries, newest scheduled first.

Query params (all optional):

| Param | Meaning |
| --- | --- |
| `date` | **One day** — `YYYY-MM-DD`. Returns every delivery scheduled that day. |
| `dateFrom`, `dateTo` | **A range** — each `YYYY-MM-DD` (or a full ISO datetime for exact bounds). Either can be given alone (open-ended). Ignored if `date` is also given. |
| `status` | `pending`, `assigned`, `on_route`, `picked_up`, `delivered`, `failed`, `completed`, `collected` |
| `driverId` | Mongo id of the driver |
| `customerId` | Exact customer id |
| `updatedSince` | ISO datetime — only deliveries touched since then (for polling) |
| `page`, `limit` | Pagination; `limit` capped at 200 |

Both filters key off `scheduledTime`. A bare date is expanded to that whole
local day (00:00–23:59), so `date=2026-09-11` gets everything scheduled on
the 11th regardless of time of day, and a range covers every day from
`dateFrom` through the end of `dateTo`.

**One specific date:**
```bash
curl -H "x-api-key: 9f2a3c..." \
  "https://matterapp.online/api/external/deliveries?date=2026-09-11"
```

**A date range** (e.g. a whole week):
```bash
curl -H "x-api-key: 9f2a3c..." \
  "https://matterapp.online/api/external/deliveries?dateFrom=2026-09-08&dateTo=2026-09-14"
```

**Combine with other filters:**
```bash
curl -H "x-api-key: 9f2a3c..." \
  "https://matterapp.online/api/external/deliveries?date=2026-09-11&status=delivered&limit=50"
```

A range spanning many deliveries paginates — check `pagination.pages` in the
response and step through with `&page=2`, `&page=3`, etc.

### `GET /api/external/deliveries/:id`

One delivery by its Mongo id.

### Response shape (same for both)

```json
{
  "success": true,
  "data": {
    "id": "66f...",
    "customerId": "C-1042",
    "customerName": "Jane Doe",
    "company": "Matter",
    "type": "Delivery",
    "address": "Villa 12, Street 4, Al Barsha",
    "locationType": "Villa",
    "zone": "Al Barsha",
    "addressId": "1042",
    "scheduledTime": "2026-09-11T04:00:00.000Z",
    "status": "delivered",
    "deliveredTime": "2026-09-11T03:42:00.000Z",
    "timing": { "status": "on-time", "lateMinutes": 0, "earlyMinutes": 0 },
    "driver": {
      "id": "66a...",
      "name": "Ahmed Khan",
      "phone": "+9715...",
      "vehicleType": "bike",
      "email": "ahmed@matter.com"
    },
    "proof": { "photoUrl": "https://...", "notes": null, "timestamp": "2026-09-11T03:42:00.000Z" },
    "gpsLocation": { "lat": 25.11, "lng": 55.20, "link": "https://www.google.com/maps?q=25.11,55.20" },
    "customer": { "customerId": "C-1042", "mealPerDay": 3, "mealPlan": "Standard" },
    "createdAt": "2026-09-08T10:00:00.000Z",
    "updatedAt": "2026-09-11T03:42:05.000Z"
  }
}
```

`addressId` is Matter's id for the saved address the delivery goes to (a string),
or `null` for manual/CSV deliveries and older rows. It identifies the *place*, so a
customer with several addresses can be told apart.

`customer.mealPerDay` is always present (pulled live from `Customer.mealPerDay`
by matching `customerId`) — this is "the number of meals this customer is
having", refreshed on every request, not a snapshot from when the delivery
was created.

### `GET /api/external/drivers/locations`

Live GPS for every tracked vehicle (same Truckoom "Trace" feed the in-app
Live Tracking page uses), with the driver mapped to it if any. Same API key
as the deliveries endpoints above — no separate key needed.

```bash
curl -H "x-api-key: 9f2a3c..." \
  "https://matterapp.online/api/external/drivers/locations"
```

```json
{
  "success": true,
  "fetchedAt": "2026-10-08T06:15:00.000Z",
  "data": [
    {
      "vehicleNo": "VEH-001",
      "vehicleType": "van",
      "location": { "lat": 25.11, "lng": 55.20 },
      "driver": {
        "id": "...",
        "name": "...",
        "phone": "...",
        "email": "..."
      }
    }
  ]
}
```

`location` is `null` for a vehicle not currently reporting a GPS fix.
`driver` is `null` for a vehicle with no driver mapped to it
(`User.profile.truckoomVehicleNo`). Polled the same way the deliveries
endpoint is — there's no history, only the current position.

## Notes

- Read-only: there is no write/update endpoint on this API. Delivery updates
  still only happen through the driver/dispatcher apps.
- Unauthenticated or wrong-key requests get `401`; if `DELIVERY_API_KEYS` isn't
  set at all, every request gets `503` (fails closed, never open).
- Timing (`late`/`early`/`on-time`) is recomputed from `scheduledTime` vs
  `deliveredTime` with the same 3-hour early threshold used elsewhere in the
  app, so it's correct even for older deliveries.


### Reconciliation metadata

Responses additionally include `matterSubscriptionId`, `addressDetails` and
`sources`. `sources.delivery` identifies a saved delivery snapshot, its available
Matter fetch/update timestamps, effective-state limitation and pin source.
Legacy rows have unknown source metadata. Nested customer address/pin values
repeat the job snapshot; they are not an independent Customer-master check.

Existing `customer.mealPerDay` and `customer.mealPlan` remain Internal customer
profile values for backward compatibility. `sources.meals` explicitly labels
them unverified against Matter with no known effective date. They must not be
used as verified kitchen subscription entitlements. Staff can use the bounded
Matter delivery-comparison endpoint to inspect profile/subscription conflicts
without overwriting custom profiles or historical jobs.
