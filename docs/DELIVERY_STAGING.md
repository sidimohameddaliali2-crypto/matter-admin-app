# Delivery-only staging API

Run `npm run start:staging-delivery` from `server/`, or use PM2 with the same
script, one process and `cwd` set to the absolute `server/` directory. This is a
separate entrypoint; `npm start` still runs the full production application.
No client build is required. The root URL returns an API-only 404, not a login page.

Required settings in the staging copy's `server/.env`:

```dotenv
NODE_ENV=production
APP_ENV=staging
PORT=5000
CLIENT_URL=https://staging.matterapp.online
MONGODB_URI="mongodb+srv://matter_staging_user:ENCODED_PASSWORD@CLUSTER/matter_staging?retryWrites=true&w=majority"
JWT_SECRET=SEPARATE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
LOCAL_TIMEZONE_OFFSET_MINUTES=240
BUSINESS_TZ_OFFSET_MINUTES=240
ENABLE_DRIVER_CAPTURE_INGESTION=1
```

Use an Atlas user restricted to `matter_staging`; the entrypoint also refuses
URIs selecting any other database. `.env.local` overrides `.env`. Integration
credentials cause startup to fail with setting names only, not secret values.
Do not reuse production users, tokens, database credentials or records.

The API reuses staff auth, users, drivers, deliveries, customers, bags,
bag operations/notes, warehouse scans, delivery issues and handoffs. Existing
route authorization still applies. Menus, partner/member portals, accounting,
Customer Service, MCP, scheduled jobs, Redis initialization and Supy warmup
are not mounted or started. Outbound WhatsApp, Google directions/geocoding,
route optimization and the placeholder `/drivers/returns` endpoint are disabled.
Driver pushes and proof reverse geocoding are disabled. This intentionally does
not qualify those integrations for release.

`POST /api/upload/delivery-photo` uses the mobile multipart field `image`, staff
authentication and a 10 MB limit. JPEG/PNG/WebP files go to `server/uploads/`,
with URLs based on `CLIENT_URL`; Spaces is not needed. `/uploads/` serves these
synthetic test images publicly, matching existing local-upload semantics.
Monitor disk usage and remove disposable test files between test campaigns;
there is no automatic retention job. This is not production evidence storage.

The listener binds to `127.0.0.1`; Nginx must proxy to it and support Socket.IO.
The authenticated in-memory Socket.IO adapter is suitable for one API process.
Use `/api/health` to verify the database connection and the staging-only mode.
Atlas TLS certificate verification stays enabled, and the Mongo pool is capped
at five connections. Keep public access to port 5000 closed.

If the independently reviewed `routes/driverEvents.js` is present, this entrypoint
mounts it at `/api/driver-events`; its own environment gate still applies.
Otherwise health reports `driverCaptureEnabled: false` and the endpoint returns
404. The gate alone does not install the route. The capture ledger does not
apply delivery/bag business actions, and an unfinished mobile uploader remains
a blocker to end-to-end tracking acceptance.

The existing mobile staging URL validator rejects `matterapp.online` and its
subdomains. Approve the exact isolated staging hostname there before building
the staging APK; do not remove production-host protection. Android builds,
real-device testing and full-shift qualification happen outside this server.

Create a staging admin with a private password using the User model, then create
the test driver through existing authenticated user APIs. Do not use the legacy
`create-admin` script's fixed default password on an internet-accessible server.

Validation: `node --test services/deliveryStaging.test.js` uses local fixtures,
a temporary upload directory and no database or external service calls.
