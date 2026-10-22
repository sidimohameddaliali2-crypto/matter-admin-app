# Bag operations: stages 1–5

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
are displayed separately. The Deposit refunds tab tracks final-return cases.
This application does not execute payments or deposit deductions.

## Stage 4: manual deposit refund tracker

Owner (2026-10-22): AED 155 bag deposit; no damage deduction policy and no
payment integration requested. One customer case represents one AED 155 deposit,
not AED 155 per bag. Management verifies the deposit is unpaid and the
subscription has ended before opening a case. There is no imported payment
ledger or automatic subscription-end verification, so this attestation matters.

Stage 3 collection events automatically appear as potential refunds in the
review queue, grouped by customer. A later warehouse receipt retains the same
return key. Read endpoints never create cases. Generic legacy return statuses
are insufficient evidence. Regular exchanges can be closed as not due with a
reason. Historical exchanges are not treated as proven unpaid deposits.

Flow: collection detected → final-return review → warehouse receipt → physical
inspection → management approval → completion recorded manually. Warehouse
staff can inspect; only admin, super admin and managers with bag permissions can
open, approve, reopen or complete cases. Drivers and dispatchers cannot access
the refund tracker, regardless of their bag permission.

All linked returns must reach warehouse and receive inspection before approval.
Any remaining customer association (including ambiguous legacy bags) blocks
approval. Further returns can be added during review. Approval captures the
exact evidence fingerprint; changed evidence requires approval again. Damage
needs management acknowledgement but the amount remains the full AED 155.
Bag repair and cleaning are independent of refund eligibility after inspection.

Completion records who verified an externally completed refund, its Dubai date
and time, optional reference and evidence notes. No bank details, payment API,
money movement or customer notification is involved. Closed cases cannot be
edited. Request IDs, optimistic versions, unique return ownership, and one active
case per customer prevent duplicate recording. A later return for a new
subscription still requires management to verify a new unpaid deposit.

API: GET/POST `/api/bag-refunds`, POST `/api/bag-refunds/:id/actions` with
`inspect`, `approve`, `reopen`, `complete`, `not_due` or `add_returns`. Writes need
a stable event ID, version and evidence note. Lists refresh every 30 seconds
while no case is being edited. The manual Refresh refunds button is always
available. New Mongo model indexes must exist before enabling production writes.
Refund endpoints bypass service-worker caching and offline queues. An offline
approval or completion fails rather than displaying a cached successful result.

## Stage 5: internal reminders and accountability

Owner (2026-10-22): internal staff reminders only. Two or more distinct
outstanding customer bag tags trigger a follow-up flag. Driver-collected and
warehouse-received bags no longer count toward that customer flag. Unverified
legacy associations get a separate verification flag, never a statement of
proven physical custody. Duplicate tag rows and aggregate quantities do not
manufacture extra physical bags. Customer balances and overview display flags.

The Reminders & reports tab derives its queue on read without creating tasks or
changing inventory. New flags and overdue verified return deadlines are due
immediately for internal review. Operators can assign an active responsible
staff member, set a Dubai reminder date, escalate, and record actual contact
made outside the app. Contact logging requires a channel and explicit
confirmation. No email, WhatsApp or other external notification is sent.

Saved reminder times apply only to the recorded custody cycle. Changed bags
require fresh review rather than silently reusing an old contact or snoozed
date. Follow-ups continue while bags remain; they resolve automatically when
customer associations clear. Histories are retained. Flags clear below two
outstanding tags; that does not itself settle any refund or prove all bags have
returned. No missing return date is fabricated.

Reports cover current staff ownership, due/escalated work, unassigned or inactive
owners, driver-held collections awaiting warehouse receipt, and pending refund
approvals/completion. Customer follow-up details export to CSV with spreadsheet
formula prefixes escaped. Accountability identifies current custody and the
next responsible person; it does not infer loss or blame. The internal queue
refreshes every 30 seconds when no form is open; it is not a background push
notification service. `/api/bag-followups` reads/writes require warehouse or
management bag access. Writes use version and custody checks, stable event IDs,
and notes. Service-worker caches and offline queues are bypassed.

Stages 6 (a separate reporting project) and 8 (subscription integration) are
removed from the proposed roadmap. Reporting above is included in stage 5.
Stage 7 customer self-service remains optional; stage 9 is the operational pilot
and rollout, independent of subscription integration.

## Stage 9: pilot and operational rollout

1. Prepare a staging environment with separate data. Verify collection,
   warehouse receipt, inspection, refund approval/manual completion, two-bag
   flags and scheduled staff reminders. Check role restrictions, offline
   failures, duplicate retries and stale custody conflicts.
2. Count and reconcile opening warehouse stock. Keep uncertain historical
   customer associations in verification, with named owners and evidence.
3. Pilot with one warehouse lead, a small delivery group and one refund
   approver. Train staff on scanning at handover, receipt vs collection, damage
   evidence, reminder ownership and recording refunds already paid externally.
4. Review the pilot each day: unassigned/due tasks, unresolved legacy links,
   bags still held by drivers and approved refunds without completion evidence.
   Agree who covers each queue and what follow-up timing the team can meet.
5. Expand after the team completes the journeys reliably. Before production,
   back up data, verify the new indexes, deploy server and client together and
   verify one controlled case. Retain a rollback plan; never delete custody or
   refund history to hide pilot discrepancies. No live rollout is performed by
   these code changes.

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
node --test services/bagLifecycleService.test.js services/bagMovementStore.test.js services/bagRefundPolicy.test.js services/bagRefundRoutes.test.js services/bagRefundWorker.test.js services/bagFollowupPolicy.test.js services/bagFollowupRoutes.test.js
```

Validation from `client/`:

```
npm test -- --watchAll=false --runInBand --runTestsByPath src/pages/BagOperations.test.js src/utils/offlineSync.test.js src/components/bags/BagRefundTracker.test.js src/components/bags/BagFollowups.test.js
npm run build
```
