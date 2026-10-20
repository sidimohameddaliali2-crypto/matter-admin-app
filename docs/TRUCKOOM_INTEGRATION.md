# Truckoom fleet GPS integration

Live vehicle GPS tracking via Truckoom's "Trace" platform
(`trace.truckoom.com`) — a third-party fleet-tracking vendor, not something
built in this app. This app only calls their existing webservice; it's not
an OAuth app or a generated API key, just a username/password/company name
sent directly in each request body.

**Status in this environment: already configured** (`server/.env` has
`TRUCKOOM_USERNAME`, `TRUCKOOM_PASSWORD`, `TRUCKOOM_COMPANY_NAME` set — the
actual values aren't repeated here since this file is checked into git).

## 1. What it's for

- **Live Tracking page** / **Driver Routes "vehicle GPS" overlay** — shows
  every tracked vehicle's current position on the map, joined against the
  driver it's assigned to.
- **`GET /api/external/drivers/locations`** — the same data, exposed to
  third-party API consumers (same static API-key auth as
  `docs/EXTERNAL_DELIVERY_API.md`).
- **Vehicle location history** — a background job samples every tracked
  vehicle's position once a minute and keeps it forever (Truckoom's own API
  has no route-replay/trail endpoint, so this app builds one itself).

## 2. Getting credentials

These are **not generated from this codebase** — they belong to whatever
Truckoom Trace account this business already has. If you ever need to
re-issue or rotate them:

1. Check the Truckoom Trace web login's **Settings / API / Integration**
   section first — most fleet-GPS vendors expose a separate API
   username/password there.
2. If there's no self-service option, contact Truckoom's account
   manager/support and ask specifically for **API credentials for the Trace
   webservice** (`getCompanyWiseVehicleData` / `getVehiclesWithLocationDetails`
   endpoints), referencing the existing fleet account so it's tied to the
   same company record.

## 3. Configuration

Set in `server/.env` (git-ignored, same file as `MONGODB_URI`/`JWT_SECRET`):

```
TRUCKOOM_USERNAME=...
TRUCKOOM_PASSWORD=...
TRUCKOOM_COMPANY_NAME=...
# Optional — defaults to https://trace.truckoom.com/webservice if unset
TRUCKOOM_BASE_URL=...
```

Restart the app (`pm2 restart matter-delivery-api` in production) after
changing these. No code changes needed — the integration turns itself on
once all three required vars are present
(`truckoomApiService.isConfigured()`), same pattern as every other optional
integration in this app (Redis, Spaces, Slack, Matter import). If any is
missing, Live Tracking falls back to showing driver phone positions only,
with a `trackerWarning` message — it never hard-fails the page.

## 3.1 Verifying it's actually working

The quickest check: open **Live Tracking** in the app — vehicles with a
live fix show on the map. From the API directly:

```bash
curl -H "Authorization: Bearer <staff JWT>" https://<your-host>/api/truckoom/vehicles
```

A `502` with "Failed to fetch Truckoom vehicle list/locations" means the
credentials themselves are wrong or expired — that error message is passed
straight through from Truckoom's own API response.

## 4. How it works (code map)

| File | Role |
|---|---|
| `server/services/truckoomApiService.js` | The only place that calls Truckoom directly. Two endpoints: `getCompanyVehicles()` (POST, JSON body — which vehicles exist) and `getVehicleLocations()` (GET, query params — current lat/lng). Genuinely inconsistent request shapes between the two, confirmed by testing against the real account, not a guess. `getFleetStatus()` merges both and caches the result 20s (`config/cache.js`) so multiple dispatchers polling Live Tracking every ~60s don't multiply into N real Truckoom calls. |
| `server/routes/truckoomApi.js` | `GET /vehicles` (fleet + driver join + reverse-geocoded address, gated behind the `live_map` permission), `PUT /vehicles/:vehicleNo/driver` (reassign which driver a tracker belongs to), `GET /history` (recorded trail for a vehicle or driver). |
| `server/routes/externalDriverLocationApi.js` | `GET /api/external/drivers/locations` — same fleet/driver join, exposed to external API-key consumers instead of staff JWT. |
| `server/jobs/recordVehicleLocations.js` | Runs every 60s (`VEHICLE_LOCATION_RECORD_INTERVAL_MS` to change it) regardless of whether anyone has Live Tracking open; writes one point per tracked vehicle to `VehicleLocationHistory`. No-ops entirely if Truckoom isn't configured. |
| `server/models/VehicleLocationHistory.js` | One row per vehicle per minute, kept forever (no automatic purge — a deliberate choice, not an oversight). `driver` is a point-in-time snapshot of whoever was mapped to that vehicle when the point was recorded, so old history stays correct even after a vehicle gets reassigned to a different driver later. |

## 5. Linking a vehicle to a driver

A vehicle (`vehicleNo`, e.g. a plate number) is linked to a driver via
`User.profile.truckoomVehicleNo` — set either from a driver's profile edit
form, or directly from Live Tracking via `PUT /api/truckoom/vehicles/:vehicleNo/driver`.
Truckoom's own `device_name` field often happens to contain the driver's
name, but that's never relied on for matching — the explicit
`truckoomVehicleNo` link is the only source of truth, so renaming a device
in Truckoom's own dashboard doesn't silently break or reassign anything here.
