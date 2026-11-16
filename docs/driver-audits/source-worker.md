# Driver Reports source worker

The Sidi source worker runs the recovered collector, morning GPS and private-validation handlers in a separate PM2 process named `matter-driver-audit-source`. The existing report builder remains `matter-driver-audit-sync`. Both preserve the recovered collection, grading and publication rules. The default storage remains the existing Supabase authority. Native mode moves reporting state and evidence into Sidi's existing MongoDB after a verified handoff.

The source runtime and credentials live under `server/.private/driver-audit-source/<manifest SHA-256>/`. Keep this directory owner-only, with directory mode `0700` and file mode `0600`. The application repository contains the supervisor and its tests. The recovered source, source environment, saved checkpoints and evidence receipts stay private.

## Native MongoDB storage

Use the app's existing `MONGODB_URI`. The source environment declares `DRIVER_AUDIT_DATA_STORE=mongo` and must contain the matching native adapter in its pinned inventory. Keep `MONGODB_URI` and `DRIVER_AUDIT_NATIVE_CAPACITY_BYTES` in the app's server environment. Source staging rejects either setting in the recovered environment, and invocation rejects disagreement between the app and source storage selection.

Native storage requires a transaction-capable replica set or sharded MongoDB deployment. `audit-source-host-check` reports transaction support, database/index allocation, filesystem headroom when available, and the native quota without changing collections. A standalone MongoDB server is not sufficient. The replica-set requirement must be verified on the actual target.

The collections are separate from operational deliveries and from the serving replica. `driverAuditNativeDocuments` preserves exact state keys and revisions. `driverAuditNativeReceipts` retains original event IDs, PostgreSQL request hashes, text and creation clocks. `driverAuditNativeHistorical` preserves original reporting rows and private review responses. `driverAuditNativeFiles` and `driverAuditNativeChunks` hold immutable bytes by content hash. Native control, leases, reservations and archive accounting use dedicated `driverAuditNative*` collections.

Blobs are losslessly compressed and split into 4 MiB chunks, allowing state above MongoDB's document-size limit. Existing matching chunks are verified and reused. Retries cannot overwrite different bytes under the same hash. An explicit `DRIVER_AUDIT_NATIVE_CAPACITY_BYTES` bounds new chunks, including a per-chunk allowance. MongoDB index and collection overhead also needs actual database headroom. The setting is independent of `DRIVER_AUDIT_CAPACITY_BYTES`, which still caps the disposable serving replica at 256 MiB. No quota is silently increased.

The app, source worker and builder use native state and archive reads after activation. Missing native objects fail visibly instead of fetching from Supabase. The source and builder continue sharing the bounded 512 MiB disk cache. Immutable reads and unchanged report sections are reused. Native app/builder reads retain byte and concurrency limits without writing Supabase reader-budget receipts. External API/model policies and native storage reservations remain enforced.

### Stage and compare the original data

`server/scripts/driverAuditMongoMigrate.js` accepts `plan`, `stage` and `verify`, followed by an absolute owner-private profile path and its SHA-256. The profile is version 1 with `targetDatabase`, `capacityBytes` and the four references `documents`, `receipts`, `historical`, `objects`. Each reference is `{ "file": "<private basename>.jsonl", "sha256": "<exact file hash>" }`. Verification also requires the pinned `runtimeRoot` and `runtimeSha256`. Inputs and archive files must be owner-private regular files in the profile directory.

Document rows use the original `{key, revision, body_text}`. Receipt rows preserve all original fields, including `created_at` as its original string so microseconds are retained. Historical rows use `{namespace, body_text}` and allow only `reporting.delivery`, `reporting.issue`, `reporting.retained_row`, `reporting.run`, and `review_private.response`. Archive rows use `{key, bytes}` with original `<SHA-256>.gz` or `<SHA-256>.json` keys. Stage the verified source bytes under those exact basenames.

`plan` reads target metadata and reports missing immutable objects and declared bytes. `stage` imports exact documents, receipts and historical rows and copies only missing archive hashes. It never selects the native authority. An interrupted stage can resume with the same pinned inputs. A final source snapshot may advance an untouched staged head using `previousImportSha256`. This refuses overwriting native edits and supports retry after interruption.

`verify` compares every supplied state document, receipt and historical row, checks collection totals, reads back the declared archive objects, and compares the loaded report and GPS queries. Its result is `staged-data-verified` with `activationPending` and `archiveClosurePending`. This is deliberately a partial check. A supplied object list cannot establish that it includes every historical photo, GPS window, grading receipt and review-linked snapshot. The command never creates an activation parity receipt. Complete closure and the normal staff, grader and saved-source journeys must be independently established from the preserved roots before calling `verifyDriverAuditMongoAuthority`.

### Final authority handoff

Leave the existing authority serving throughout staging. Before the final delta, stop and drain the old collector/grader schedules **and all old review-write endpoints**. Review saves do not use the collector lease. Take and restore-check a fresh final backup after stopping those writers. Import the final snapshot and receipts, verify complete archive closure and compare all results, photos, GPS and every review namespace. Check read/save/retry/reload through the app and qualify the exact Linux host.

`activateDriverAuditMongoAuthority` requires the exact import and parity hashes, no intervening native writes, both old writer fences, drained leases and a final-backup clock within a fresh window of at most 30 minutes. Production native initialization refuses a staged or unverified authority. Set both the app and recovered source to `mongo` only for this verified handoff. Restart the app/sync under the same settings and use the existing source start controls and proofs below. Observe an actual new delivery, photo, GPS update, completed grade and saved review through the app before declaring the migration live.

Stopping the new source worker preserves native state and history. If native writes have occurred, rollback must retain native authority until those new reviews, grades and collector changes have been reconciled and verified into the prior authority. Changing the environment back alone would expose an older journal. Keep the encrypted original backup and avoid archive deletion while final ownership, restoration or required historical links remain unresolved.

## Host and staging

Run the reviewed `Deploy to DigitalOcean` workflow on the exact deployed application commit. `audit-source-host-check` reports available Node executables, versions and required APIs, free memory and disk, the deployed commit, and the three managed process states. It performs read-only checks. Supply `source_node_executable` to inspect another absolute path. Qualify the exact Linux Node executable using source imports and isolated parity before activation. Record that executable and exact `process.version` in the source bundle.

`audit-source-stage` accepts `expected_sha`, `audit_source_manifest_sha256`, `audit_source_bundle_sha256` and `source_node_executable`. Supply the private compressed bundle through environment secrets `DRIVER_AUDIT_SOURCE_BUNDLE_01` through `DRIVER_AUDIT_SOURCE_BUNDLE_12`, with at most 48 KiB of base64 text per chunk. Supply the source environment separately through `DRIVER_AUDIT_SOURCE_ENVIRONMENT_B64`. Secret values are read directly by the host process and excluded from its output.

The workflow assembles the files privately on the runner, checks the bundle hash, creates an owner-private host transfer directory and copies the two files through the commit-pinned SCP action. The final host operation reads owner-only files directly. Successful staging removes those transient host files and runner cleanup removes its private transfer directory. Failed host inputs remain in their private transfer directory for inspection and an exact retry.

The bundle is gzip-compressed JSON. Hash the compressed bytes before base64 encoding. Its format is

```json
{
  "version": 1,
  "manifestSha256": "<manifest SHA-256>",
  "nodeExecutable": "/absolute/qualified/node",
  "nodeVersion": "v24.21.0",
  "files": [
    { "path": "manifest.private.json", "dataBase64": "<exact manifest bytes>" },
    { "path": "source/api/collector.mjs", "dataBase64": "<exact source bytes>" }
  ]
}
```

Include the manifest and every file declared by its inventory. The example contains one source entry for brevity. The staged `runtime` tree must contain the full inventory. Source staging verifies the compressed hash, manifest hash, each file's size and hash, and rejects extra files, unsafe paths and symlinks. Repeating an identical stage verifies its saved files. A conflicting stage preserves the existing release.

The separate environment is a JSON object mapping environment variable names to strings. Preserve the recovered switches exactly. It includes the declared collector credentials and `AI_GATEWAY_API_KEY` when grading is enabled. The adapter supplies that API key in the original handler's identity header. Confirm the key against the original Gateway catalog and eligibility check and through isolated grading parity. Persisted Vercel OIDC tokens are rejected.

For a source release with the persistent archive reader, set `MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY` to the managed builder `archiveCacheDirectory` reported by `audit-source-host-check`. The scheduler and builder share that owner-only directory. The cache reuses immutable files by SHA-256 across processes, fits its existing 512 MiB limit, and stops adding files when the build reserve is needed. Upload verification still reads the object back from its archive. Keep the deployment environment and the cache directory bound to the same builder during qualification and start.

Staging writes `source.json` with the exact runtime, environment hash, executable and version. Worker activation uses the separate start operation. The initial cursor is supplied by the final cutover evidence. `audit-source-check` verifies these inputs and imports the three scheduled handler modules in isolated child processes.

## Qualify on the Linux host

Upload the reviewed replay fixture as a private, content-addressed `<SHA-256>.gz` archive object using the normal archive reservation and reader budget. The gzip JSON contains the staged source runtime manifest hash, a SHA-pinned saved-state document, the exact immutable archive keys and lengths needed by the saved replay, and the previously verified output counts and hashes. The source qualification allows a 1 MiB compressed fixture and at most 112 MiB of declared archive objects. Keep the fixture and the local replay receipt private.

Run `audit-source-qualify` with the deployed application commit, source manifest, source Node executable and `audit_source_qualification_sha256`. Leave the existing source schedules running until the cutover fence and leave the new source process stopped. The operation holds the shared heavy-work lock so the online sync process can wait without overlapping the rehearsals.

The qualification runs the exact recovered collector request through the app adapter against the saved capture. It verifies failure recovery, duplicate detection and the preserved row, photo grade, history and archive output fingerprints. The builder uses the pinned deployed code, renderer, validation journals, Node executable and heap settings. Its candidate lives in a temporary private workspace. The builder uses its archive-backed baseline and verifies immutable objects from the original local cache or ordinary budgeted archive reads. The isolated processes get no production credentials. Application-level network calls are restricted to the saved replay transport and the parent only obtains bounded verified archive reads. The normal reader ledger records those downloads.

When the persistent reader is configured, the two isolated source processes share a temporary cache. The receipt records archive requests and bytes for the cold and warm replay and binds the result to the operating builder cache path. Startup requires a verified reduction and checks current build-volume headroom. Check the measured provider usage after activation as other scheduled jobs and real evidence changes can have different read patterns.

The operation collects Linux process resident memory and high-water values, present API and sync memory, available memory and disk. After a verified build and validation, it keeps that disposable builder process alive during a second source replay to measure retained memory. The existing build disk reserve still applies. If a stage cannot finish, the workflow returns a partial receipt with the stage and reason. The application requires a verified receipt before source startup.

Read the bounded JSON result in the SSH step of the raw GitHub Actions job log. The GitHub CLI run-log view can omit nested action output. The host writes an owner-private `qualification-<fixture SHA-256>.private.json` under the staged source root. Preserve its reported `receiptSha256` and fixture hash in the parity receipt as `"hostQualification": { "fixtureSha256": "<fixture hash>", "receiptSha256": "<host receipt hash>" }`. Startup verifies the host receipt bytes and the exact app, source, environment, Node and builder settings. Run qualification again when those settings change.

## Cutover evidence

`audit-source-start` requires the exact source manifest plus `audit_source_release_file` and `audit_source_release_sha256`. The release receipt pins the staged configuration and four evidence files. Each evidence file must contain `version: 1` and `verified: true`, with the verification details retained alongside those fields.

```json
{
  "version": 1,
  "verified": true,
  "configSha256": "<exact source.json SHA-256>",
  "runtimeManifestSha256": "<manifest SHA-256>",
  "environmentSha256": "<environment.private.json SHA-256>",
  "nodeVersion": "v24.21.0",
  "initialCursor": "2026-11-16T04:00:00.000Z",
  "verifiedAt": "2026-11-16T04:01:00.000Z",
  "validUntil": "2026-11-16T04:16:00.000Z",
  "backup": { "path": "backup.private.json", "sha256": "<hash>" },
  "parity": { "path": "parity.private.json", "sha256": "<hash>" },
  "credentials": { "path": "credentials.private.json", "sha256": "<hash>" },
  "sourceFence": { "path": "fence.private.json", "sha256": "<hash>" }
}
```

The source-fence evidence also requires `writersStopped: true`, `leasesDrained: true`, the same `initialCursor` and a `validUntil` covering the release receipt. Record the exact old schedules and writer checkpoints in that evidence. The initial cursor is the last UTC minute already owned by the old scheduler. A fresh activation window may be at most 30 minutes. Prepare the fence only after the old writers have stopped and drained.

Use `audit-source-proof-stage` to transfer later evidence through the same workflow. Set `audit_source_manifest_sha256` and `audit_source_proof_sha256`. The environment secret `DRIVER_AUDIT_SOURCE_PROOF_B64` contains gzip-compressed JSON, base64 encoded, with at most 48 KiB of text. The JSON format is `{ "version": 1, "files": [{ "path": "backup.private.json", "sha256": "<hash>", "dataBase64": "<bytes>" }] }`. Only unique `*.private.json` basenames are accepted. Files are written under `<release-root>/proofs/<compressed envelope SHA-256>/`. Use that directory's `release.private.json` as the start input. References by basename resolve relative to the release receipt, allowing all evidence to travel in one envelope.

The checks establish that the reviewed bytes are present and mutually bound. The operator's backup and parity evidence must demonstrate actual restoration, complete source and review preservation, isolated handler outcomes, the exact credential identity and host resource qualification.

## Process controls

The workflow exposes the following explicit operations. Supply the exact deployed commit, source manifest and qualified Node executable for each operation except the read-only host check and proof staging.

| Operation | Effect |
| --- | --- |
| `audit-source-check` | Verify private files, configuration, runtime and handler imports. |
| `audit-source-qualify` | Replay the saved source and builder with Linux memory and disk measurements. |
| `audit-source-start` | Verify fresh cutover evidence, persist activation, start the source process and verify its heartbeat. |
| `audit-source-pause` | Stop the source process, drain children and verify release of its SQLite lock. |
| `audit-source-resume` | Restart the same paused registration using its saved active receipt. |
| `audit-source-rollback` | Stop the source process and mark its activation rolled back. |

For an already authorized host session, the equivalent commands are

```sh
DRIVER_AUDIT_DEPLOY_SHA="$REVIEWED_APP_SHA" \
DRIVER_AUDIT_SOURCE_MANIFEST="$SOURCE_MANIFEST_SHA" \
DRIVER_AUDIT_SOURCE_NODE="$QUALIFIED_NODE" \
"$QUALIFIED_NODE" server/scripts/driverAuditSourceDeploy.js audit-source-check

# Complete the saved Linux source and builder qualification before the fence.
export DRIVER_AUDIT_SOURCE_QUALIFICATION_SHA256="$HOST_FIXTURE_SHA256"
"$QUALIFIED_NODE" server/scripts/driverAuditSourceDeploy.js audit-source-qualify

DRIVER_AUDIT_DEPLOY_SHA="$REVIEWED_APP_SHA" \
DRIVER_AUDIT_SOURCE_MANIFEST="$SOURCE_MANIFEST_SHA" \
DRIVER_AUDIT_SOURCE_NODE="$QUALIFIED_NODE" \
DRIVER_AUDIT_SOURCE_RELEASE_FILE="$PRIVATE_RELEASE_RECEIPT" \
DRIVER_AUDIT_SOURCE_RELEASE_SHA256="$RELEASE_RECEIPT_SHA" \
"$QUALIFIED_NODE" server/scripts/driverAuditSourceDeploy.js audit-source-start

DRIVER_AUDIT_DEPLOY_SHA="$REVIEWED_APP_SHA" \
DRIVER_AUDIT_SOURCE_MANIFEST="$SOURCE_MANIFEST_SHA" \
DRIVER_AUDIT_SOURCE_NODE="$QUALIFIED_NODE" \
"$QUALIFIED_NODE" server/scripts/driverAuditSourceDeploy.js audit-source-rollback
```

Ordinary app deployments pause an existing source worker before replacing app code and resume its same registration after app health checks. The source control re-executes through its qualified Node interpreter when the API uses another version. An inactive installation remains inactive. A failed deployment retains the pause.

Rollback retains all source data, archive objects, review journals, schedule state and private release files. Restore the old scheduler only after the Sidi source process is stopped, its lock is released, and the shared remote leases have drained. Reconcile the latest saved source checkpoints before resuming the old schedule. A later Sidi start requires fresh fence evidence.

## Runtime behavior and verification

Each invocation receives the original request method, URL, cron schedule header and user agent. Every job runs in a separate child with the pinned source environment and a 3,072 MiB V8 heap limit. Handler budgets, leases, disabled switches, retries and result publication remain in the recovered code. Child stdout and response bodies are excluded from the process log. The private status keeps bounded result states and the pending-job count.

The worker holds the existing SQLite-backed lock pattern across its lifetime. It durably records each scheduled occurrence before dispatch and executes one child at a time. Pending work survives pause, restart and admission contention. Admission atomically removes the queued occurrence and records it as running before the handler begins. An interrupted admitted claim remains recorded, and the next scheduled invocation uses the source handler's existing recovery behavior. Missed minutes while the scheduler was offline are counted. The final cutover fence advances the saved cursor past work already owned by the previous scheduler.

The source child and report sync share `server/.private/driver-audit-heavy-work`. Its short queue lock gives admission in arrival order, and its separate OS-backed work lock excludes overlapping heavy work. Source children hold that work lock through process exit. Sync holds it across source loading, build, validation, bundle preparation, import, recovery and maintenance for one tick. Waiting releases no source-data lease or budget reservation because the recovered handler starts only after admission. Stopping a waiting source child preserves its queued job. Stopping a waiting sync tick cancels admission. Process death releases the OS lock, and later admission removes stale process tickets.

The isolated collector replay reached about 4.09 GB RSS with the 3,072 MiB heap limit. The heap limit bounds V8 heap while native buffers also consume memory. The long-lived sync process may retain memory after a tick. Host qualification must measure available memory, both process RSS values and the existing API during consecutive source and sync runs before production acceptance. The shared work lock proves execution exclusion, with host memory fit still requiring that measurement.

The admission change updates the sync implementation fingerprint. Requalify replica retention through the existing restore-and-rollback proof workflow before re-enabling reclamation. The prior retention receipt becomes stale under the existing fingerprint checks.

Each child has the recovered 300-second maximum. Graceful shutdown drains active children, and the PM2 kill timeout allows that drain. A hard supervisor failure disconnects children so they exit. The heartbeat records job results, missed minutes and the last saved schedule minute. Startup readiness proves process and configuration readiness. Verify subsequent real capture, photo/GPS evidence, grading, publication, saved reviews and staff reads before completing production acceptance.

Local tests are `node --test services/driverAuditSource.test.js services/driverAuditSourceDeployment.test.js services/driverAuditSourceStage.test.js services/driverAuditHeavyWork.test.js` from `server/`. Run the complete `npm test` suite as well.
