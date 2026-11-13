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

The capture endpoint is mounted before general JSON parsing, with its own
64 KiB / 64-event JSON limit and a 750000-byte JPEG limit. Set
`ENABLE_DRIVER_CAPTURE_INGESTION=1`; APP_ENV must remain staging. Health reports
`driverCaptureEnabled`. No capture route is added to the production entrypoint.

`POST /api/driver-events/batch` authenticates a driver, validates account-scoped
stable IDs, preserves immutable original metadata and deduplicates by canonical
payload hash. Accepted IDs are returned only after majority+journal Mongo writes
and majority read-back. Partial failures are explicit; changed payloads conflict.
It is a capture ledger: `deliveryStateApplied: false` is mandatory.

`PUT /api/driver-events/photos/:photoId` accepts original JPEG bytes after its
photo.captured ledger event. Use image/jpeg, X-Capture-Event-Id and X-Content-MD5.
The account, delivery assignment, original size and checksum must match. Original
bytes are stored privately in matter_staging.driver_capture_photos using the same
write concern and read-back. Stable retries return the same receipt without
recompressing/overwriting evidence. Photo bytes are not publicly served and this
does not modify delivery proof, customer pins, bag state or business timestamps.
There is no automatic capture retention/deletion policy; monitor staging DB size.

The mobile staging build allows exactly https://staging.matterapp.online/api as
an exception to the MATTER production/subdomain block. Native transport also
requires com.matterapp.online.staging, refuses redirects and stores only an
Android-Keystore-encrypted runtime bearer token. Passwords are never build inputs.
Unique network-constrained WorkManager jobs retry bounded batches and stream
original JPEG files. Additive SQLite v1-to-v2 migration preserves original rows;
per-event metadata and byte receipts are separate, rejected evidence is retained,
and acknowledgements do not delete local photos or apply business actions.
Legacy delivery requests/retry queues remain responsible for business completion;
full business replay/idempotency, pending-business-action migration and fleet
qualification remain separate release requirements. Do not merge PR #69 to deploy
staging: production deployment is triggered only from main, which is unchanged.

Create a staging admin with a private password using the User model, then create
the test driver through existing authenticated user APIs. Do not use the legacy
`create-admin` script's fixed default password on an internet-accessible server.

Validation: `node --test services/deliveryStaging.test.js` uses local fixtures,
a temporary upload directory and no database or external service calls.
