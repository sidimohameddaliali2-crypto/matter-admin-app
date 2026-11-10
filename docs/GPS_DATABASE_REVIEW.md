# GPS database design and review

This document helps maintainers review the GPS persistence changes and qualify them before deployment. It covers the affected database paths, not every business rule in the application. It contains no production records or customer data.

## Existing responsibilities

The application uses several separate representations:

| Area | Models | Responsibility |
|---|---|---|
| Saved vehicle observations | `VehicleLocationHistory` | Samples of the provider's last-known position, with the sampler's record time. |
| Provider working caches | `TruckoomLiveSnapshot`, `TruckoomTrackHistory` | Shared live refresh coordination and a replaceable normalized vehicle-history cache. A cache is not an immutable archive. |
| Request coordination | `TrackerSyncLease` | Shared ownership and cooldown for provider operations. Lease expiry is not evidence retention. |
| Account assignment | `User.profile.truckoomVehicleNo` | The account-to-tracker mapping used by GPS collection. It has no effective-date assignment history. |
| Operational vehicles | `Vehicle` | Operational vehicle records and `assignedDriver`; these are not interchangeable with provider identifiers or the GPS mapping. |
| Delivery evidence | `Delivery.trackerVisit` and proof fields | Customer-specific visit interpretation and photo evidence. Position time, photo time and physical handover are distinct. |

Repository model/index declarations and the relevant live collection metadata were inspected read-only. Live metadata confirmed the saved-history query indexes and related collection identities. Schema inference used a bounded sample; it does not prove all historical rows have one shape. The connector's index output provides names and keys, not every option. Verify uniqueness, TTL, collation and partial-index options directly in the deployment environment before making an operational claim about them.

A legacy driver collection can coexist with the account model. Do not use a collection's existence or a current vehicle assignment as proof of historical identity or complete provider-fleet coverage.

## Add two persistence responsibilities

The proposed models separate evidence retention from recovery:

| Model | Purpose | Identity and retention |
|---|---|---|
| `TruckoomGpsReceipt` | Retains a compressed, scoped JSON response before normalization, with its clock and content hash. The retained JSON is not an original HTTP wire capture. | Receipt ID; source hash; response-time index. No TTL is declared. |
| `VehicleLocationCaptureBatch` | Retains one sampling tick and its immutable normalized payload until acknowledged persistence, including explicit pending or failed outcomes. | Deterministic tick ID; owner/fence lease; recovery index on state, lease and tick time; separate tick-time index for day-scoped health reads. No TTL is declared. |

`VehicleLocationHistory` receives optional source-reference, clock, quality, assignment and batch-provenance fields. Existing historical rows remain readable. Coordinates become nullable so a known vehicle's unusable observation remains visible to the quality evaluator rather than disappearing between valid fixes. Valid legacy positions are unchanged. No legacy history deletion, backfill, unique-index replacement or guessed timestamp migration is required by this change.

The mutable history cache receives a source-receipt reference. Previous retained receipts remain independent when the cache refreshes. Missing/invalid positions remain in retained source evidence and in known-vehicle history observations with explicit quality flags. The external history API returns `location: null`; the staff history API returns null coordinates for unusable positions. The visit evaluator must retain these as uncertainty instead of connecting valid fixes across them. Preserving an observation does not make it a valid map point.

## Recovery invariants

The capture store enforces these rules:

1. A scheduled tick is claimed once through its document identity.
2. A payload is saved before derived rows are written. A repeated save must match the same payload hash.
3. Each derived history row receives a deterministic ObjectId from the batch ID and row position. Retrying a partly acknowledged batch uses insert-if-absent operations with the same IDs.
4. History rows preserve `captureBatchId` and `captureRow`, and the store verifies each written chunk's identities before completion.
5. Ownership and fencing protect batch completion. An expired worker can only attempt the same immutable rows; it cannot complete a newer owner's batch.
6. An interrupted tick with no retained payload becomes explicitly failed. A later live response is not relabeled as that original tick's observation.
7. Recovery processes a bounded pending batch and seals a bounded abandoned unsaved tick per poll, so it does not intentionally replay an unlimited backlog ahead of live capture.
8. An unknown database acknowledgement is not proof of failure or success. Retry/readback reconciles the retained batch; it does not discard prior rows.

The batch store and receipt archive use majority and journal acknowledgement. A batch's payload limit is 2,000 rows and 4 MiB, checked against both JSON and BSON size before persistence; bulk writes are bounded. A receipt allows at most 32 MiB of JSON and 8 MiB after compression, and the provider GPS requests also bound response size. These are processing limits, not an estimate of fleet size or a guarantee of cluster capacity. Oversized input remains an explicit failed capture requiring review; it must not silently truncate.

## Compatibility and operational effects

Existing collection consumers query vehicle or driver with `recordedAt`. Preserve those indexes and the API's clock meanings. Do not add a unique driver-to-vehicle constraint as part of this change: existing ambiguity needs to remain inspectable, and assignment updates occur through separate operations.

Retaining responses and normalized pending payloads increases storage and write work. Cached repeated positions remain legitimate observations; deduplication belongs in a derived reporting view rather than deletion from the source archive.

If raw-response retention fails, the live service can still return normalized positions for operational viewing with an internal unretained-evidence status. The recorder refuses to acknowledge that snapshot as retained history and records a failed tick when the batch store remains available. An unavailable database cannot record its own outage; subsequent schedule reconciliation must expose missing ticks, and abandoned claims are sealed during recovery. The raw-retention fallback does not guarantee availability during provider outages or failures of the shared Mongo live cache itself; existing operational error/fallback paths still apply. Transport failures may have no response body to retain. Preserve their explicit failure outcomes and distinguish them from received but rejected payloads.

Live retention scopes rows to the configured company; history retention scopes rows to the requested vehicle. Out-of-scope rows are excluded and the stored payload is a scoped JSON representation, not a verbatim provider envelope. Registry responses are not covered by these two receipt kinds, so expected-fleet completeness still requires independent reconciliation.

The capture-status API queries one Dubai date with a bounded result limit and projects aggregate states/counts. It does not return raw receipt payloads, coordinates or driver identities, and it does not certify a full day merely because a tick is marked complete. Its tick-time index is additive on the new batch collection; no live index was created during this work.

Receipt hashes verify retained content identity. They do not independently prove the provider's information was correct, the database was backed up, or a later restore will be available. Original raw bytes, normalized caches, capture batches and reporting copies have different roles.

## Deployment qualification

Before promotion, record the actual application revision, process count and database configuration, then verify:

- The two new collections and their intended indexes can be created with the deployment role; existing collections/indexes remain intact.
- The existing application account retains necessary read/write access without expanding external API access to raw payloads.
- Storage, compression, index growth and write load are acceptable under the deployed fleet and capture schedule.
- The deployment's write concern, journaling, replica-set behavior and backup settings match the intended durability requirements.
- A real isolated database test passes partial insert, unknown acknowledgement, two-worker contention, lease expiry and restart recovery.
- Recovery qualification distinguishes the isolated candidate restore from an operational Atlas snapshot restore. Existing daily snapshots are verified. Before source deployment, test an existing snapshot in isolation or record the deployment owner's explicit acceptance of the unverified operational recovery risk. Snapshot download is not a gate for development or reporting validation. An undeployed candidate's new collections cannot already be present in an older production snapshot.
- After approved source deployment, and before report promotion, a complete closed delivery day reconciles expected collection outcomes, saved observations, distinct fixes and export pages separately.
- Rollback changes code without deleting retained evidence or resetting completed/pending batches. The reviewed older code preserves additive fields on reads but does not implement the new recovery or GPS uncertainty rules; withhold new GPS-derived report publication until compatible processing resumes and passes reconciliation.

Offline fixtures exercise failure behavior and Mongoose casting without database writes. They do not replace the real database and restore checks. No live database mutation, index creation or backup change was performed during this review.

Current capacity must be measured against the existing allowance without changing retention or purchasing a larger tier. Report receipt, batch, observation and index costs separately, with the original saved response hash and candidate revision. If only normalized cache data is available, use it to measure normalized rows/batches and label raw-response receipt cost unmeasured; do not reconstruct a provider response and call it original evidence. Any growth scenario must state fleet count, interval, active hours and receipt reuse assumptions. Current free space alone does not establish long-term capacity because the proposed evidence collections have no automatic expiry.

### Read-only runtime diagnostic

The deployment owner can download `server/scripts/inspectGpsRuntime.mjs` from the exact reviewed PR revision to a temporary directory on the existing Linux API host, without checking out the PR or merging main. Run it as the existing API process owner:

```sh
umask 077
node /tmp/inspectGpsRuntime.mjs > /tmp/gps-runtime.private.json
```

Send that JSON through the existing private handoff. The helper scans readable API processes, runs the actual Node executable with `--version`, and reads the checkout commit. It never starts the application, invokes PM2, opens a database/provider connection, or changes server settings. It returns allowlisted metadata and a hash of the database username; passwords, full connection strings, raw environment variables and customer records are omitted. Its only external parser is the already-installed dotenv dependency from the identified server directory. No installation is needed.

If discovery reports unavailable, use `--pid` only with the actual existing API Node worker PID; do not restart the server to make the diagnostic pass. Current checkout and environment-file reconstruction are explicitly distinguished from the already-loaded code/configuration. The configured timer is not proof of successful capture or fleet completeness. Missing metadata remains unverified; the helper does not attest database defaults, actual journal acknowledgements or full index options.

## Isolated recovery evidence (2026-11-10)

The explicit harness `server/scripts/qualifyGpsRecovery.mjs` starts its own
single-node MongoDB replica set on `127.0.0.1` with WiredTiger. It never loads
application environment files, accepts a database URL, imports server startup,
or contacts the GPS provider. Its two synthetic namespaces and temporary BSON
backup are removed when the run finishes. It is deliberately outside fixture
auto-discovery and requires separate test tooling, without application lockfile
changes. From the repository root, using PowerShell:

```powershell
npm install --prefix work/gps-recovery-tooling mongodb-memory-server@11.3.0 --no-audit --no-fund
$gpsRecoveryTool = (Resolve-Path work/gps-recovery-tooling/node_modules/mongodb-memory-server/index.js).Path
node server/scripts/qualifyGpsRecovery.mjs $gpsRecoveryTool
```

The initial run used Node 22.20.0 and MongoDB 8.2.6. Six assertion groups passed:

- Concurrent workers produced exactly one claim for a tick.
- An actual partial prefix write followed by application disconnect/reconnect
  recovered exactly three deterministic history rows.
- Actual Mongo writes followed by an injected lost acknowledgement, lease expiry
  and a new worker recovered exactly six rows across two batches; the stale
  owner could not complete the batch.
- An injected lost completion acknowledgement did not reopen the completed batch.
- A graceful mongod stop/restart retained three complete batches and nine rows.
- BSON file backup and logical restore into a separate local namespace preserved
  all nine complete row values and identities, recomputed batch payload hashes,
  payload membership and source-reference receipt hash/decode.

This exercise found a source-recovery defect: native/lean Mongo reads return a
BSON `Binary` payload; `Buffer.from(Binary)` produced empty bytes and receipt
decoding failed with `Z_BUF_ERROR`. The decoder now extracts the BSON bytes
explicitly. The same real-database harness and a BSON round-trip fixture passed
after the fix (five archive fixture tests passed).

These are synthetic fault injections after real local writes, not a network
partition or multi-node failover test. Application restart is represented by a
fresh store plus disconnect/reconnect; database restart is graceful. The backup
exercise is logical BSON export/import, not `mongodump`, filesystem recovery or
the production backup service. Abrupt host failure, deployment-role permissions,
actual index options, deployed process count, capacity/storage growth, replica
configuration and production backup/restore remain unverified. Repository PM2
configuration examples and deployment commands do not establish the actual
running process topology. Do not treat this evidence as deployment approval.

### Additional existing-access checks

The existing local database connection was subsequently located and used for read-only schema/type, complete existing index-option, privilege, replica/storage and bounded growth checks. Private operational results are intentionally excluded from this repository. This narrows the initial access limitation but does not establish the deployed runtime principal, all durability defaults, production backup arrangements or capacity under the added retention load. No live index or collection was created. Deployment and staging acceptance gates remain open; see the impact record's existing-access follow-up.

### Row-to-original-response linkage through recovery

The recovery harness now creates three distinct scoped source receipts **before** saving their capture batches. It runs the actual live normalizer and capture classifier, includes unusable GPS fields, and deliberately makes source-row indexes differ from capture-row indexes by retaining an unidentifiable source row and excluding an out-of-scope company. Independent originals are held by the test, separately from the saved database and backup.

At application reconnect/partial recovery, lost-acknowledgement recovery, graceful database restart and logical restore, every saved observation must resolve through its batch membership and `sourceReceipt.receiptId` to the correct archived response. Assertions compare receipt IDs, hashes, source-row indexes, scope and original request/response clocks; decode and hash the archived content; compare it with the independent original response; replay its selected source row; and compare every normalized saved field with the independent pre-write original. All nine observations must retain their deterministic identities and exactly three complete batches must remain after restart/restore.

In-memory negative controls prove the verifier rejects a missing receipt, a wrong source-row index, a changed reference hash, substitution of another valid receipt even when row/batch references and the batch hash are updated together, and a normalized quality-field mutation even with a recomputed batch hash. These controls leave the restored evidence intact.

This specifically closes the previous harness gap: archive readback alone did not establish that restored history rows still referenced their own original responses. It is source-link recovery verification, not a replay of saved delivery assessments or the downstream reporting importer. The existing single-node, graceful-restart and logical-backup limitations still apply.

The restart step also waits for the previous test `mongod` child's `close` event before starting its replacement. This avoids a Windows test-tool race where delayed pipe closure could reject the replacement's startup listener. Startup failures remain failures; assertions are not retried or suppressed.

Final linkage-harness verification passed eight assertion groups on three consecutive normal runs, including restart and restore plus the negative controls. The full explicit offline server suite also passed 682/682 tests across 89 files with non-loopback TCP connections blocked. No application behavior, live data, provider usage, deployment or reporting-importer code changed.

### Local process-loss and replica-failover qualification

The optional `--faults` mode extends the same synthetic harness to three local
WiredTiger replica members. It requires an already installed `mongod` binary and
disables runtime downloads. It accepts no external database URI. Run it with
existing tooling and the installed binary, for example from a POSIX shell:

```sh
MONGOMS_RUNTIME_DOWNLOAD=false node server/scripts/qualifyGpsRecovery.mjs \
  /absolute/path/to/mongodb-memory-server/index.js \
  --faults /absolute/path/to/mongod
```

The new checks use only process handles created by this harness:

- A separate Node capture worker saves an acknowledged history-row prefix and
  waits. The parent sends `SIGKILL`, verifies the signal, lets its lease expire,
  and proves a different owner recovers the complete immutable batch with all
  source links intact. The child does not release the lease before exiting.
- A three-member replica set saves a majority-acknowledged history prefix. The
  harness kills its current primary with `SIGKILL`, verifies a different member
  becomes writable primary, fences the previous batch owner, and checks exact
  row identities, original receipt content, clocks and batch membership after
  completion on the surviving members.

This mode passed ten assertion groups using Node 24.21.0, the existing MongoDB
7.0.14 binary and mongodb-memory-server 10.4.3 on macOS. No dependencies or
MongoDB binaries were installed or downloaded. The earlier logical BSON restore
checks still cover their original three batches; the two additional fault-test
batches are verified against independent originals after recovery, not claimed
as an operational backup restore.

Process loss on a local machine is not abrupt host/power loss, a network
partition, geographic failover, disk corruption or the deployed Atlas topology.
The test does not identify the deployed application credential, inspect actual
backup policy, restore an operational backup, measure production capacity or
approve deployment. The default single-member qualification remains available.
