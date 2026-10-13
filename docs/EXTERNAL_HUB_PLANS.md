# External fixed-hub driver plans — protocol 1

Source implementation; **tests/builds/phone checks have not been run**. Do not treat this branch as deployment or dispatch approval. The external planner retains routing ownership: neither import nor driver events invoke the optimizer or send notifications.

## Versions and storage

Use the backend and Android `codex/hub-pickup-driver-flow` branches together. Old Android builds cannot operate these assignments: unrevisioned completion/assignment endpoints reject managed deliveries. Existing non-plan customer workflows remain separate.

MongoDB must support multi-document transactions (replica set or supported cluster). Imports, driver actions and cancellation fail without that support. The new `ExternalRoutePlan` collection has a unique service-date index. `Delivery` gets optional `externalRoutePlan`, `externalRouteRevision`, `externalRouteStateVersion`, `externalRouteTiming` and `proof.captureId` fields. No SQL migration or account changes are included. Installation, environment configuration, deployment, production import and driver notification are outside this change.

## Import and review

Authenticated staff with admin, super_admin, dispatcher or manager role may `POST /api/route-plans/import`. The request contains:

| Field | Contract |
| --- | --- |
| `serviceDate` | Dubai `YYYY-MM-DD`; one current plan for the service day |
| `revision`, `expectedRevision` | Positive integer and previous integer; first import is `1, 0` |
| `requestId` | Stable unique import ID; retry the identical request after an uncertain response |
| `routes[]` | `driverId` (real active driver Mongo ID), `vehicleType` (`bike`/`van`, matching profile), `vehicleLabel`, `initialBatchId`, `initialCargo[]`, `stops[]`; vans also require `hub` |
| `initialCargo[]` | `{deliveryId, bagIds: [physical label, ...]}`; every customer is initially on exactly one bike or van |
| Customer stop | `{id, type: 'customer', deliveryId, point, earliestAt, plannedArrivalAt, plannedCompletionAt, planByAt, deadlineAt}` |
| Pickup stop | `{id, type: 'pickup', transferId}` in the exact bike visit order, including pickups before customer zero |
| Final return | Optional final bike stop `{id, type: 'return', point, plannedArrivalAt}`; cannot reload or carry unfinished deliveries |
| `transfers[]` | `{id, batchId, vanDriverId, bikeDriverId, point, pickupAt, plannedDepartureAt, cargo[]}` |
| `point` | `{lat, lng, name}`; numeric Dubai bounds. Hub points must exactly match their stationary van's hub. Customer coordinates and deadlines must match current source deliveries. Pin equality is not physical site verification. |
| All times | ISO 8601 with explicit offset or `Z`; normalized to UTC without losing service date |

Every deadline uses D−180 minutes opening and D−30 minutes planned completion cutoff. Stops must run forward in time, including pickup handling through `plannedDepartureAt`. Each transfer must consume exactly the van's declared cargo once and precede its corresponding customer stops. The current model caps bikes at 15 carried customers and vans at 80; these are planning assumptions, not physical load verification. Up to 3 vans / 6 bikes are accepted, allowing bounded test fixtures; import does not certify full-cohort coverage, road feasibility, parking or an operational manifest.

The response is `{success: true, data: {id, serviceDate, revision}}`. `GET /api/route-plans/:id` returns the full current plan and event/revision receipts to authorized staff. Imports atomically persist assignments, supplied windows and the complete ordered plan. They do not synthesize hub customer records. Cancel via `POST /api/route-plans/:id/cancel` with `{expectedRevision, requestId}`. Cancellation increments the revision and stops execution, retaining physical cargo/progress. It does not claim that loaded stock has been returned.

A replacement uses the same service date, a new request ID and next revision. Completed route prefixes, already loaded initial stock and started/completed transfers are immutable; replan only the remaining feasible work. All drivers must acknowledge the replacement. Source corrections (pin, deadline or source record changes) block execution of the old plan until replacement. Unknown/deleted/reassigned/cancelled work cannot be silently completed by an old offline event.

## Driver execution

`GET /api/route-plans/mine` and the extended `/api/deliveries/driver/today` provide participant-scoped plan data. The latter also retains legacy `handoffs` and advertises `externalPlanProtocol: 1`. Visibility covers yesterday/today, plus tomorrow after `NEXT_DAY_AVAILABLE_HOUR` (default 16:00 Dubai). Native navigation selects a service date explicitly, defaults to today's plan, and labels future plans as advance review.

`POST /api/route-plans/:id/events` uses `{driverId, eventId, revision, type, ...}`. `driverId` must equal the authenticated driver. Keep `eventId` and the entire body unchanged on retries.

| Type | Additional fields / effect |
| --- | --- |
| `acknowledge` | Records this driver's review of the exact revision |
| `load` | `cargo` exactly matching the declared initial manifest; records physical load confirmation |
| `arrive` | `transferId`, `location: {lat,lng}` within 100m of the real hub pin |
| `confirm` | `transferId`, `batchId`, exact `cargo`, current `location`; requires both drivers' arrivals, acknowledgements and loads, and planned transfer completion time. Custody changes only when both confirm. |
| `exception` | `transferId` or own `stopId`, `reason` from `delayed`, `missing_counterpart`, `wrong_cargo`, `blocked_access`; visible to both participants/staff, never implies transfer or delivery |
| `complete` | Next customer `stopId`, current `location`, optional scanned `bagId`, uploaded `proof.photoUrl`/`proof.images` and optional `proof.captureId`; saves real customer completion atomically with plan progress. Rejects before opening, wrong bag and out-of-order work. Actual late completion is recorded, not rewritten as on time. |
| `return` | Final return `stopId`, current `location`; marks the explicit final return only |

The Android app retains its photo/QR capture controls, saves new photo files in its document directory before queueing, and uses an account-scoped durable outbox. Upload URLs are persisted before event submission. Offline actions remain pending; they never advance authoritative stock or stop selection. Conflicts remain visible and require review, not automatic replay under a newer revision. Refresh/focus and 15-second foreground polling retry pending events and reload current state. Local evidence files are retained; storage-retention policy is not implemented here.

Hub operations intentionally do not create reusable `Bag` inventory rows or mark reusable bags returned to the warehouse. The declared labels identify the physical cargo; customer proof and existing non-plan bag-return workflows remain distinct.

Admin route preview reads imported timing directly and labels it as planned, not live ETA. The legacy ETA path now returns every pickup in `detours[]`; the legacy singular `detour` field remains only for compatibility.

## Verification still required

Jacob chose “Implement and push; leave checks explicitly unrun” on 13 October 2026. No safe pre-existing remote check workflow exists; no new workflow was added and no local tests, installs, builds, servers or database commands were run.

Prepared fixtures: pure validation/event tests, MongoDB transaction integration with isolated synthetic IDs, and native parser/stop-selection/outbox tests. Integration tests require a localhost disposable replica-set URI in `MONGO_TEST_URI`; without it the integration test is skipped. They must not use a shared database.

Before rollout: run backend `npm test` on a safe runner with the isolated Mongo fixture enabled; native `npm test -- --runInBand` and Android bundling/build; admin client build. Then verify actual devices against an isolated identified backend: initial loads, two different hub pickups, both drivers' cargo, wrong batch, missing counterpart, duplicate submission, changed/cancelled plans, offline photos/reconnect/restart, midnight/date selection, GPS/proximity, and existing non-plan photo/QR/bag return flows. No screenshots or phone proof are supplied by this source-only branch.

Deployment compatibility, actual phone rendering, GPS accuracy, photo upload retry semantics after an ambiguous upload response, physical cargo capacity, and hub access remain unverified. The server event and stock mutation is idempotent; the existing photo-upload endpoint has no idempotency contract, so an uncertain upload could leave an orphan uploaded image even though customer completion cannot duplicate.
