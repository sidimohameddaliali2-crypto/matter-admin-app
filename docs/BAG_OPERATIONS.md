# Bag operations: stages 1–3

The combined Admin & Warehouse workspace is `/bags`. `/store-keeper` redirects
there. Staff authentication and effective `bags` permissions remain in force.
No database backfill or production deployment runs as part of this change.

## Opening inventory

Run `node scripts/auditBagInventory.js` from `server/` for a read-only audit.
It reads native Mongo collections without importing application models or
creating indexes, and saves `tmp/bag-inventory-audit.json` outside tracked files.
Historical unknown codes do not mean physically missing bags. Never strip
leading zeros or merge tags based on their numeric suffix alone.

Legacy records have no `lifecycleState` or `verifiedAt`; the UI labels them
unverified. A physical opening observation needs an operator, evidence note,
and explicit confirmation of the tag at the warehouse. It creates received
stock, not ready stock. Non-unit quantities require reconciliation first.

## Physical journey

`received → cleaning → ready → packed → outbound → with_customer → collected → received`

An operator can release received stock after confirming cleaning and inspection,
so the explicit `cleaning` step is optional. Poor-condition or flagged bags are
not releasable. A prepared handover stays in warehouse custody until the nominated
driver accepts it in the existing driver web screen. Cancellation is allowed only
before acceptance. Driver-to-driver offers likewise retain the original holder
until the receiving driver accepts.

Collection is driver custody. Only authorized warehouse staff can receive it.
Receipt is separate from cleaning. Damage needs a description and uploaded
photo; repair returns the bag to the cleaning queue. Retirement is limited to
management and physical stock at warehouse. Hard deletion and quantity overrides
are rejected by the legacy adapter.

Customer associations, confirmed customer holdings, and driver-collected bags
are displayed separately. No deposit deduction or refund is executed. Final
subscription return cases and payments belong to the later deposit stage.

## Data and concurrency

Each movement uses a stable `eventId`, actor, fingerprint, before-state, timestamp
and evidence. State, custody version and history event are committed in one atomic
bag-document update. The version is compared before writing. Retries of the same
event return the receipt; conflicting actions fail with 409. There is no automatic
reconciliation or inference that old warehouse records are ready stock.

Related delivery receipts are updated only for the delivery captured by the bag
receipt. This secondary update is retryable from the original event, never across
all historical uses of a bag. A multi-bag request can partially succeed; the client
keeps the request pending and retries using deterministic per-bag event IDs.
Successful physical movements are not rolled back or silently repeated.

`BagReviewCase` stores evidence notes, reviewer and review state with optimistic
versions. Saving a review never changes custody or verifies inventory.
`BagStockCount` stores the recorded baseline, observed tags and differences,
deduplicated by submission ID. Submitting a count never overwrites stock.

## Endpoints

- `GET /api/bag-operations`: recorded inventory, live audit queues, customer
  associations, reviewers and submitted counts. No write side effects.
- `GET /api/bag-operations/bags/:id`: full recorded bag history.
- `POST /api/bag-operations/register`: register one physical tag into received stock.
- `POST /api/bag-operations/movements`: action, bagId, eventId, note and optional
  expectedVersion, inspected confirmation, driverId, deliveryId or proofPhotoUrl.
- `GET /api/bag-operations/pending`: the authenticated driver's pending handovers.
- `PUT /api/bag-operations/reviews`: evidence-only case update with version check.
- `POST /api/bag-operations/stock-counts`: idempotent evidence-only count submission.

Legacy bag return/reassignment/assignment routes call the same movement service.
They cannot create inventory from an unknown scan. Drivers cannot claim warehouse
receipt or provide another driver's identity. GET `/api/bags` is side-effect free;
drivers must search an exact ID.

## Offline and rollout

Delivery completion sends all outgoing and incoming IDs to the server in typed
proof fields. Offline collection tasks retain their collection type. Standalone
collections persist to IndexedDB before syncing. Failed bag movements remain
failed/pending, and failed photo uploads do not complete their delivery update.
Warehouse handover acceptance requires a server connection before departure.
Movement capture timestamps are retained. Offline events older than a newer
verified handover are rejected for custody review instead of overwriting it.

Deploy backend and client together after review. Start with a warehouse physical
count and individual opening observations; do not mass-default legacy rows to
ready. Unknown tags and conflicting customer associations need operator review.
Previously cached clients get explicit conflicts for deprecated inventory writes.

Validation from `server/`:

```
node --test services/bagLifecycleService.test.js services/bagMovementStore.test.js
```

Validation from `client/`:

```
npm test -- --watchAll=false --runInBand --runTestsByPath src/pages/BagOperations.test.js src/utils/offlineSync.test.js
npm run build
```
