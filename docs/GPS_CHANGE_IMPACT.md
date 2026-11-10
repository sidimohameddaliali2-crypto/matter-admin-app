# GPS reliability change impact and verification

This document helps maintainers review GPS collection changes without altering unrelated delivery, ordering, kitchen, or reporting behavior. It maps the repository's major areas, identifies the paths that use GPS evidence, and defines the checks required before deployment.

The initial inventory used base commit `73b8f2915c15eee08aa5aa6677a2bd4092552c7e`. It covers the tracked server and client module inventory, mounted routes, background jobs, models, tests, and deployment workflow. GPS-dependent paths received a detailed source trace. Other areas received dependency and boundary inspection, not a line-by-line correctness, security, or production audit.

## Repository coverage

The following areas were inventoried and checked for direct GPS/history/visit dependencies:

| Area | Entry points and major modules | Review depth and boundary |
|---|---|---|
| Startup and deployment | `server/server.js`, `loadEnv.js`, middleware, cache/Spaces configuration, `.github/workflows/deploy-digitalocean.yml` | Traced startup, job registration, environment loading, API mounts, connection behavior and automatic deployment. Do not import the application entry point during offline tests. |
| Authentication and permissions | Staff auth/users/drivers, partner/member auth, static external API keys, socket auth, MCP OAuth | Traced the authorization boundaries used by GPS reads and assignment writes. GPS changes must not broaden permissions or mix authentication schemes. Other auth behavior is inventory-only. |
| Vehicle GPS and live locations | `truckoomApiService`, `truckoomLiveData`, `recordVehicleLocations`, `truckoomApi`, `externalDriverLocationApi`, `VehicleLocationHistory`, live snapshot/history/lease models | Detailed producer, cache, persistence, serialization, assignment and caller trace. Preserve phone-location fallback and vendor request coordination. |
| Tracker visits | `truckoomVisitSync`, `trackerGpsVisits`, `truckoomVisitRules`, `truckoomHistoryService`, alert/geofence lifecycle services and models | Detailed clock, date, fallback, evidence source, lease, proof snapshot and delivery-update trace. GPS-derived evidence must remain separate from real geofence events. |
| Delivery and driver workflows | Delivery/customer/driver routes and models, delivery order/timing/completion services, handoffs, route optimization and geo services | Traced GPS-dependent assignment and proof-receipt boundaries. Delivery status transitions, bag completion, route optimization, address edits and offline proof behavior remain separate contracts. |
| Reporting and integrations | Reports, external delivery API, driver KPI service, Matter API/import/sales/MCP, Xero, communications, webhooks, notifications | Checked for GPS/visit consumers and shared model coupling. KPI calculations use delivery timing/status fields, not tracker visit verdicts. Business/revenue logic is inventory-only and must remain unchanged. |
| Bags and warehouse | Bags, bag operations/notes/follow-ups/refunds, stock/scans, lifecycle/movement services and models | Inventory and shared delivery/user boundary inspection. No direct GPS-history consumer found. Preserve completion and scan flows. |
| Menus, kitchen and customer subscriptions | Menus/selection, kitchen preparation/production, customer profiles, subscription/pause services, partner/member orders | Inventory and shared model/API boundary inspection. No direct GPS-history consumer found. Preserve ordering, meal choices and fulfillment rules. |
| Administration and other operations | Employees/leave, events, vehicles/fuel/incidents, yellowblock, issues/alerts, mobile-update policy | Inventory and shared infrastructure boundary inspection. No direct GPS-history consumer found outside named vehicle/driver paths. |
| Frontend and offline storage | `App.js` routes, Redux stores, socket context, mobile/offline helpers, service worker, shared API clients | Traced live-map, tracker-card and driver-assignment consumers. Other pages are inventory-only; compile and regression tests cover accidental shared import/schema changes. |
| Maintenance scripts, optimizer and historical artifacts | `server/scripts`, ad-hoc root scripts, `server/optimizer`, root notes and generated outputs | Inventoried only. Do not execute migration, cleanup, customer-update or vendor diagnostic scripts as regression tests. Historical documents are not deployed-behavior proof. |

At the base revision, the tracked tree includes seven background jobs: flagged customer notification, moving uncollected collections, driver KPI recalculation, Matter delivery import, Matter sales capture, vehicle-location recording and customer tracker-visit synchronization. The GPS PR must preserve registration and behavior of the five unrelated jobs.

## Direct GPS dependency paths

### Collection and live viewing

`server/server.js` starts `jobs/recordVehicleLocations.js`. The collector requests the shared fleet service, reads driver mappings and stores history. `truckoomApiService.getFleetStatus()` combines company registry and normalized live positions through Redis and Mongo-backed live caching.

The same fleet service serves:

- Staff `GET /api/truckoom/vehicles`, protected by staff authentication and `live_map` permission.
- External `GET /api/external/drivers/locations`, protected by static API-key authentication.
- Live Tracking, the Driver Routes map overlay, and the edit-driver vehicle selector.

Changing fleet fields or error behavior affects all these callers. Preserve the staff route's phone-only fallback when vendor positions fail. Raw response retention must not accidentally expose private response bodies through object spreading in staff APIs.

### Saved history reads

The external history endpoint filters by `recordedAt`, sorts by `recordedAt` and `_id`, and returns `gpsTime` separately. Its date-only inputs use Dubai business-day bounds. Full timestamp `dateTo` is inclusive and becomes an exclusive bound by adding one millisecond.

The staff `/api/truckoom/history` route is a separate consumer with its own cap and response projection. Review it explicitly when adding capture fields or changing history semantics. No in-repository frontend caller of that route was identified during the base trace; that does not prove there are no external callers. Preserve legacy fields and document any additive completeness information.

### Assignments

Driver assignments can be edited through both:

- `PUT /api/truckoom/vehicles/:vehicleNo/driver` from Live Tracking.
- Driver profile editing through `routes/drivers.js` and `EditDriverModal`.

The base implementation does not establish an immutable effective-dated assignment history. A capture-time mapping is an observation of configuration, not proof of who drove at an older GPS fix time. Detect ambiguity in reads/capture; do not assume one write endpoint prevents conflicting assignments everywhere. Avoid adding uniqueness constraints to existing user data without a separate compatibility and migration review.

### Delivery proof and visit presentation

The driver app sends camera capture time/source separately from upload/receipt time. Delivery routes strip client attempts to set server-owned tracker evidence and call `recordProofReceipt`. The visit synchronization service freezes destination and assignment context once proof is received and writes tracker evidence with a conditional update against the delivery version.

Preserve these boundaries:

- GPS repair must not modify delivered/completed times, delivery status, bag scans or driver KPI inputs.
- The special `delivery:trackerVisit` event must remain separate from normal completion notifications.
- Historical geofence alerts and GPS samples remain distinct sources. Preserve the base branch's `getAlertData` and archived geofence-event path.
- Additive tracker evidence fields must be declared in `Delivery.trackerVisit`; undeclared fields can disappear during persistence.
- `TrackerVisitCard` has explicit labels for known status values and polls the delivery endpoint. A new status needs a compatible, plain-language rendering without changing the layout.
- Driver route maps and Live Tracking use the frozen visit pin/radius for customer circles. Do not replace those pins with an inferred location or change saved radius semantics.

## Review hazards

Check these implementation hazards before accepting the final diff:

1. Retaining only the normalized fleet cannot recover fields discarded before normalization. Retain permitted source response data at the appropriate transport boundary.
2. `geofenceRequest` is shared by reads and mutating geofence operations. Scope any retention hook to the intended read operations and avoid archiving authentication secrets.
3. A process-local overlap flag does not coordinate multiple workers. Shared vendor caching also does not deduplicate history writes.
4. MongoDB acknowledgement timeout can occur after a write succeeds. Recovery must reconcile deterministic identities rather than insert another copy or lose the original batch.
5. New schema defaults can change serialized legacy rows. Verify old/new `.lean()` and JSON API behavior explicitly.
6. A cache refresh or replay must not replace old evidence, invent a missing clock, or silently assign an old fix to today's driver.
7. New indexes should target additive collections or additive fields with deliberate compatibility. Do not reset, purge, rename, or rebuild existing operational collections as part of routine startup.
8. A source read/export must not trigger live or history vendor refresh. Test those calls as forbidden dependencies in the saved-data route tests.
9. Saved GPS needs both time-window bounds and source-row reconciliation. A successful HTTP status, empty list, or page count alone is not proof of a complete day.
10. A raw-retention failure must not become a false acknowledged capture; any operational fallback must expose its evidence limitation.
11. Retaining an unusable response separately is insufficient if normalization removes it before visit evaluation. Trace invalid coordinates, missing clocks and conflicting vehicle rows from both live collection and historical API responses through the final comparison. Surrounding usable fixes must not bridge a discarded uncertainty marker.

## Verification plan

Execute the tests against the final diff, and record actual results in the PR. This checklist is a required plan, not an assertion that every check has passed.

| Scope | Required checks |
|---|---|
| Capture and persistence | Retained source identity, missing/invalid positions, missing/future clocks, zero speed, duplicate mapping, overlap, partial insert, unknown acknowledgement, restart, lease expiry and two-worker processing. |
| Live and cached data | Cache-hit metadata, Redis unavailable path, Mongo-backed coordination, failed requests, cooldown timing, absent registry/live vehicle and duplicate vehicle rows. Preserve existing live consumers. |
| History | Fresh/stale cache, failed/empty response distinction, immutable retention, bounds around Dubai midnight, three-minute cooldown after success/failure/auth delay, multi-page export and truncation rejection. |
| Visit interpretation | Null-clock exclusion, exact-fix repeats, long gaps, same-time coordinate conflicts, jumps, invalid coordinates, late receipts, multiple visits, frozen assignment/pin, non-GPS geofence behavior and unknown photo capture time. |
| APIs and UI compatibility | Missing/wrong static keys, staff permissions, old/new serialization, null/zero values, phone-only fallback, driver-map overlay, tracker-card wording/timestamps and map circles. |
| Shared delivery behavior | Driver proof submission/retry/offline sync, address/date edits, completion failure, external delivery serialization, delivery order and KPI inputs. |
| Wider regression | Explicit server fixture suite; client tests for tracker card/live tracking, offline sync and shared delivery timing plus a client production build. Inventory-only areas remain subject to ordinary regression coverage. |
| Qualification environment | Real Mongo partial failure/restart/readback, actual process configuration/index readiness, bounded browser journey, one closed delivery day, independent archive restore and replay equivalence. Fixtures do not replace these checks. |

### Keep test execution isolated

Use explicit `*.test.js` fixture files from service, route, model and utility directories. The repository also contains ad-hoc test/maintenance scripts that call real integrations or modify data. Do not use those scripts as regression tests, and do not start `server/server.js` merely to exercise fixtures.

If dependencies are reused through a read-only symlink, redirect every writable cache before running client checks. Create React App uses webpack, Babel and ESLint caches under `node_modules`; setting only the output build path is insufficient. Use a private dependency copy or an external temporary cache configuration while preserving the normal compiler and lint checks. Keep build output in the isolated checkout. Never install into or change a borrowed operational dependency tree.

## Local verification record — 2026-11-10

The isolated candidate was checked against base `73b8f2915c15eee08aa5aa6677a2bd4092552c7e` using Node.js 24.21.0. The final explicit server fixture run covered 89 files and 679 tests: 676 passed and three failed. All three failures reproduced on the unchanged base with the same dependencies and isolation:

- `server/routes/manualCoords.test.js:157` and `:177`: `deliveries.findOne()` buffered without a database mock and timed out.
- `server/services/managedMenuSave.test.js:237`: the partner synchronization assertion received a warning instead of an empty warning list.

No new server fixture failures were observed. The production client build compiled successfully with its normal compiler and lint checks. Webpack, Babel and ESLint caches and build output were redirected into the isolated candidate; borrowed dependencies were protected against writes. The build emitted a bundle-size advisory and a Node deprecation warning. Separately, the existing `TrackerVisitCard.test.js` suite passed all eight tests. These component fixtures are distinct from the production build and do not establish browser behavior. `git diff --check` passed.

For the same server fixture scope, run the following from the repository root in an isolated environment with service credentials removed and non-loopback network connections denied. Do not run ad-hoc integration scripts or start the application:

```sh
node --input-type=module <<'NODE'
import { execFileSync, spawnSync } from 'node:child_process';
const files = execFileSync('rg', ['--files', 'server', '-g', '*.test.js'], {
  encoding: 'utf8',
}).trim().split('\n').sort();
const result = spawnSync(process.execPath,
  ['--test', '--test-concurrency=4', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
NODE
```

No staging or production application, real browser/device journey, real database recovery, index creation, backup restore or closed-day reporting acceptance was exercised by these local checks. Those remain the deployment qualification steps above.

## Release boundary

The deployment workflow runs when `main` is pushed and supports manual dispatch on `main`. It installs server/client dependencies, builds the client and restarts the API. Creating a PR does not validate deployment. Merging to `main` is a production action and must follow the deployment acceptance checklist.

Before promotion, confirm the actual process count, database durability/index configuration, rollback path and backup/restore proof in the owning environment. The repository's example process configuration is not production evidence. Rollback must preserve appended evidence and existing reviews. Unrelated pre-existing findings belong in a separate backlog rather than expanding this GPS patch without a reviewed reason.

## Independent follow-up qualification — 2026-11-10

A second review started from candidate `a697d41b24f8857ebe41b73708fa35368126e5db` with separate database/recovery, GPS interpretation and application compatibility reviewers. It independently found and fixed two defects:

- An unusable observation cleared impossible-jump destination taint, allowing unchanged later coordinates to support a false visit. Taint now survives uncertainty barriers until a usable changed position; regression fixtures cover six barrier types and valid movement recovery.
- Receipt decoding failed for BSON Binary payloads returned by native/lean Mongo reads. The decoder now handles both BSON Binary and hydrated Buffer payloads, with BSON round-trip and real database readback coverage.

Using Node 22.20.0, the final explicit server run covered 89 fixture files and 682 tests: **679 passed, three failed**. The unchanged base covered 84 files and 604 tests: **601 passed, the same three failed**. The two manual-coordinate failures arise from missing mocks for database reads in unchanged address-edit hooks. The menu-save failure arises from mocking `findOne()` as a Promise although unchanged code calls query `.sort()`. Temporary diagnostic mock repairs passed all four targeted checks, including the intended synchronization error case; the original fixtures were restored and these unrelated changes are not included in this PR.

The GPS evaluator/history/synchronization group passed 80/80 after its regression was first observed failing. Application compatibility routes passed 25/25, and the existing tracker-card suite passed 8/8. The isolated Mongo recovery and logical restore evidence, its reproducible harness and its limits are recorded in [database review](GPS_DATABASE_REVIEW.md#isolated-recovery-evidence-2026-11-10).

**Deployment recommendation: not ready.** The initial follow-up had not located the existing local database connection; additional read-only qualification subsequently used it (see below). Actual process count, deployed database principal, complete durability configuration, retention capacity and operational backup arrangements remain unverified. Real staging journeys for maps/fallback, both assignment paths, photos/retry/offline sync, edits and saved reload, plus the separate reporting importer and late-recovery reconciliation, remain acceptance gates. Repository workflow/configuration review and fixture coverage do not close those gates. No production data, provider calls, historical reports, collection pauses, merges or deployments were changed.

The follow-up client production build (`npm run build`) also passed with normal compiler and lint checks using its own locked dependency installation. It emitted browser-data currency and bundle-size advisories; no checks were disabled. Build output remained in the isolated checkout. `git diff --check` passed before the follow-up commit.

### Existing-access follow-up

After locating the existing local connection, additional database checks ran read-only: collection/type metadata, complete existing index options, authenticated privileges, replica/storage metadata and two bounded storage snapshots. Operational details remain private and are not committed. This corrects the initial access limitation; no database writes, live index creation or provider requests were performed.

These checks do not prove that the deployed process uses the inspected local credential. Some durability/default configuration commands were unsupported or did not expose the requested setting; journaling and production backup arrangements are not established. A short legacy-storage observation is not a capacity forecast for the PR's additional retention. Existing deployment SSH credentials were rejected, and browser inspection could not initialize, so running process count and staging journeys remain unverified. The deployment recommendation remains **not ready**.
