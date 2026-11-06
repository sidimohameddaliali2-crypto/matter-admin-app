# Full reporting workspace (draft integration)

This feature mounts the existing full report inside the staff application's Report section. Both flags default off, preserving the current Report page and all production jobs. Do not enable this in production as part of reviewing the PR.

## Boundaries

- `REACT_APP_REPORTING_WORKSPACE=true` selects the full reporting page at client build time.
- `ENABLE_REPORTING_WORKSPACE=true` enables `/api/reporting-ui` on the server. It requires `REPORTING_APP_ORIGIN` (exact staff app origin), `REPORTING_SERVICE_ORIGIN` (private HTTPS origin, no path), and server-only `REPORTING_SERVICE_CREDENTIAL`.
- The configured service must implement the report document, immutable `report-data` resources, status, photo metadata/images, review reads/saves, and explicit fresh/API refresh endpoints. Deployment, credential provisioning, service-side authorization, and durable multi-worker review storage remain release gates. The existing workstation preview is not that production deployment.
- The backend checks existing staff authentication and `reports` permission before every request and again before releasing evidence. Review/refresh actions additionally require an allowed staff role, same origin, and the iframe session's CSRF value. The backend supplies the reviewer name and sends trusted actor identity to the private service.
- Browser-supplied history is never imported. The old renderer's initial `reviews/migrate` call is a compatibility read of the saved journal; the submitted browser state is ignored and remains in that browser.
- The opaque reporting cookie lasts 90 seconds and is renewed by the visible app component every 30 seconds. It is HttpOnly, SameSite=Strict and Secure on HTTPS. Sessions are held per process: multiple API workers require sticky routing or a shared session store before enabling. Staff credentials and service keys never appear in iframe URLs or report documents.
- Session renewal uses the current shared staff credential. Other-tab logout/account changes remove the report. A new session generation remounts an expired iframe; ordinary renewals preserve open forms.
- Source errors return a bounded message. They do not replace the saved report or erase response history. The renderer retains its data/source inspection and reporting controls; duplicate demo navigation is hidden only within the embedded document.

## Verification

Client: `CI=true npm test -- --watchAll=false --runInBand`, then `REACT_APP_REPORTING_WORKSPACE=true REACT_APP_API_URL=/api GENERATE_SOURCEMAP=false npm run build`.

Server: `npm test`. New HTTP tests exercise actual staff JWT/permission middleware with synthetic users, no database connection. They cover denied/disabled reads, viewer writes, CSRF/foreign origins, authenticated reviewer, path allowlists, source credential isolation, expiry, logout and access revocation while reading. Two existing `routes/manualCoords.test.js` pre-save/update hook tests time out on `deliveries.findOne()` without MongoDB; the same failures reproduce on the untouched base. Do not connect these tests to production to make them pass.

The local browser rehearsal serves the built real application with a synthetic staff identity, current read-only reporting evidence and a separate copied response journal. It never runs the operational `server.js`, database connection or background jobs. Private evidence, host scripts and screenshots are excluded from this public repository.

## Before release

Provision and test the private reporting service, authenticated durable response storage, deployment/rollback, capacity and multi-worker sessions. Verify real staff acceptance in a separate staging environment. Only then decide whether to enable the flags. Merging to `main` deploys the application automatically; this change must remain a draft until those gates and release approval are satisfied.
