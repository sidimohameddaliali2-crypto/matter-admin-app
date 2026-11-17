# Driver Reports source worker

Use this guide to stage, qualify, operate and recover the Sidi source worker. Start with the [maintenance map](maintenance-map.md) for component and source ownership, staff routes, upstream inputs, storage, configuration and tests.

**Native migration status: PENDING.** The native mode described here requires the final authority handoff and actual production acceptance. Merged code, a staged import, fixture parity or a worker heartbeat does not establish activation or live data flow. Keep exact deployed identities and acceptance evidence in the private release record; update this status only after those checks complete.

The Sidi source worker runs the recovered collector, morning GPS and private-validation handlers in a separate PM2 process named `matter-driver-audit-source`. The existing report builder remains `matter-driver-audit-sync`. Both preserve the recovered collection, grading and publication rules. The default storage remains the existing Supabase authority. Native mode moves reporting state and evidence into Sidi's existing MongoDB after a verified handoff.

The source runtime and credentials live under `server/.private/driver-audit-source/<manifest SHA-256>/`. Keep this directory owner-only, with directory mode `0700` and file mode `0600`. The application repository contains the supervisor and its tests. The recovered source, source environment, saved checkpoints and evidence receipts stay private.

## Native MongoDB storage

Use the app's existing `MONGODB_URI`. The source environment declares `DRIVER_AUDIT_DATA_STORE=mongo` and must contain the matching native adapter in its pinned inventory. Keep `MONGODB_URI` and `DRIVER_AUDIT_NATIVE_CAPACITY_BYTES` in the app's server environment. Source staging rejects either setting in the recovered environment, and invocation rejects disagreement between the app and source storage selection.

Native storage requires a transaction-capable replica set or sharded MongoDB deployment. `audit-source-host-check` reports transaction support, database/index allocation, filesystem headroom when available, and the native quota without changing collections. A standalone MongoDB server is not sufficient. The replica-set requirement must be verified on the actual target.

The collections are separate from operational deliveries and from the serving replica. `driverAuditNativeDocuments` preserves exact current state keys and revisions. `driverAuditNativeReceipts` retains required original event IDs, PostgreSQL request hashes, text and creation clocks. `driverAuditNativeHistorical` preserves original reporting rows and private review responses. `driverAuditNativeFiles` and `driverAuditNativeChunks` hold immutable evidence by content hash. Historical technical bookkeeping belongs in the verified recovery backup. Native control, leases, reservations and archive accounting use dedicated `driverAuditNative*` collections.

Blobs are losslessly compressed and split into 4 MiB chunks, allowing state above MongoDB's document-size limit. Existing matching chunks are verified and reused. Retries cannot overwrite different bytes under the same hash. An explicit `DRIVER_AUDIT_NATIVE_CAPACITY_BYTES` bounds new chunks, including a per-chunk allowance. MongoDB index and collection overhead also needs actual database headroom. The setting is independent of `DRIVER_AUDIT_CAPACITY_BYTES`, which still caps the disposable serving replica at 256 MiB. No quota is silently increased.

Imported historical receipts use lossless Brotli packs so repeated old checkpoints share compression. A normal batch contains at most 64 receipts or 8 MiB of original body/event text. Every receipt retains its own key, revision, event ID, request/body hash and original creation clock. UTF-8 offsets and text hashes select its exact body and event. Packs and receipt metadata commit together, and stored pack bytes are read back before commit. The decoder supports the existing gzip references, bounds decoded packs at 64 MiB and retains at most one 8 MiB decoded pack. This changes storage encoding only. It does not merge or discard original receipts.

Only selected evidence/recovery receipts are imported. All original bookkeeping remains in the complete encrypted source backup. All current heads stay exact, including current spending, reserved attempts, schedule progress, GPS configuration, photo repairs and uncertain model calls. The selector excludes only known technical budget/login/map-counter history. Unknown keys stay protected. Preserve every photo-grade and visual-audit result receipt, every review and household-arrangement journal and its receipts, plus the collector revisions named by source/current/previous/bootstrap and retained-workspace roots. No service-day or delivery-count filter applies.

New technical saves use `driverAuditNativeTechnicalRecords` and `driverAuditNativeTechnicalChunks`, separately from immutable evidence. The latest state remains exact. Recent retry payloads have a 15-minute recovery window, longer than the maximum source invocation. Expired superseded payloads, receipts and their charged bytes are reclaimed together on a subsequent technical write. Reads use a snapshot so reclamation cannot invalidate an in-flight read. A 64 MiB recovery ceiling and the configured native quota both apply. Exhaustion refuses a write rather than evicting a recent uncertain operation. This is limited recovery state, not permanent report history.

Large protected state text, including collector publications, uses deterministic content-defined chunks. Unchanged text sections share immutable compressed bytes across revisions, including after insertions and process restart. Original whole-text hashes, UTF-8 text, request identity and receipt revisions stay exact. Gzip and imported Brotli references remain readable. No collector or human-review revision is pruned by this codec. An initial encoding can have additional chunk metadata; subsequent changes reuse unchanged pieces.

Only verified released archive reservations and their completed operation records receive a 24-hour expiry. Pending or uncertain reservations, per-object archive identity and usage totals remain durable. Disposable road geometry expires according to its existing cache lifetime. These expiry indexes never target evidence, results or human review collections.

The app, source worker and builder use native state and archive reads after activation. Missing native objects fail visibly instead of fetching from Supabase. The source and builder continue sharing the bounded 512 MiB disk cache. Immutable reads and unchanged report sections are reused. Native app/builder reads retain byte and concurrency limits without writing Supabase reader-budget receipts. External API/model policies and native storage reservations remain enforced.

`driverAuditNativeReviewContexts` and `driverAuditNativeReviewFiles` preserve the original report contexts named by human review events, including photo-generation, inventory, queue and image manifests. The small index points to existing native archive hashes; images are not copied again. Compare all preserved publication scopes before selecting an original context, and retain provenance and preexisting missing outcomes. A staff runtime asks this index only when its current catalog lacks a path. Integrity failures remain failures. This lookup is native-only and cannot fetch old data from Supabase. Index writes share the native import authority fence and never edit a journal or source report.

### Stage and compare the original data

`server/scripts/driverAuditMongoMigrate.js` accepts `plan`, `stage` and `verify`, followed by an absolute owner-private profile path and its SHA-256. The selective profile is version 2 with `targetDatabase`, `capacityBytes` and references `documents`, `receipts`, `historical`, `objects`, `reviewContexts` and `reviewDependencies`. Each reference is `{ "file": "<private basename>.jsonl.gz", "sha256": "<exact file hash>" }`; uncompressed `.jsonl` is also accepted. Verification also requires the pinned `runtimeRoot` and `runtimeSha256`. Inputs and archive files must be owner-private regular files in the profile directory.

`bookkeepingBackup` pins an owner-private JSON proof using `{file,sha256}`. The proof requires `verified: true`, `originalsPreserved: true`, the exact `originalReceiptSha256` matching the complete receipt input, its `receiptCount` and the restored original `sourceDumpSha256`. The input count and every selected receipt are checked. The live importer refuses historical technical receipts, including calls outside the CLI.

Create the selected receipt transfer beside the recovery backup, using `server/scripts/driverAuditSelectReceipts.js <absolute private profile> <profile SHA-256>`. Its version-1 profile pins `sourceReceipts`, `bookkeepingBackup`, and `collectorRoots` using `{file,sha256}`, plus an owner-private `outputDirectory`. The collector proof contains the actual target plan's `collectorRevisions` and `collectorRootsSha256`. The exporter reads and checks the complete original receipt input, then produces `live-receipts.private.jsonl.gz` and `live-receipts-proof.private.json`. Repeating it verifies existing output rather than overwriting it. Only these selected files need to reach Sidi's host; historical technical logs stay at the backup location.

For that transfer, set `receiptInput: "selected"`, pin the selected gzip as `receipts`, and pin its proof as `bookkeepingBackup`. The proof additionally binds `liveReceiptSha256`, `liveReceiptCount` and `collectorRootsSha256`. A selected input containing excluded bookkeeping is rejected. `receiptInput: "full"` remains available for a backup-side rehearsal; it checks and filters the original export directly.

Provide the actual managed `syncRoot` whenever the target already serves a direct report. Planning reads bounded configuration, bootstrap, local pointer, accepted/seed/retirement records and file-manifest metadata in private managed UUID workspaces. Mongo current/previous serving roots and local accepted candidates are distinct: a validated candidate can await bundle preparation or publication. Abbreviated previous references resolve through exact matching accepted, seed, retirement or bootstrap identities; the census never rewrites a pointer or invents a revision. It protects their complete union, validates source/basis/manifest bindings and full seed schemas, rejects unresolved identities or direct stages, and rereads metadata and serving roots to detect drift. The result contains `collectorRevisions` and `collectorRootsSha256`. Pin that census hash in the profile before staging. Every required collector revision must occur in the original receipt export. Stage and verify recheck the census; changing app or workspace roots requires a new plan. Recollect the actual target census under the final writer fence before activation.

Document rows use the original `{key, revision, body_text}`. Receipt rows preserve all original fields, including `created_at` as its original string so microseconds are retained. Historical rows use `{namespace, body_text}` and allow only `reporting.delivery`, `reporting.issue`, `reporting.retained_row`, `reporting.run`, and `review_private.response`. Archive rows use `{key, bytes}` with original `<SHA-256>.gz` or `<SHA-256>.json` keys. Stage the verified source bytes under those exact basenames.

`reviewContexts` contains one `{snapshotHash,availability,manifest?,provenance}` row per distinct hash named by any original review journal. `availability` is `available` or `source-missing`. `reviewDependencies` contains one `{snapshotHash,files:[original manifests]}` row per context, including explicit empty arrays for old unavailable dependencies. Indexing checks supplied original bytes and conflicts. Its supplied list remains a partial inventory: independently derive and compare complete snapshot/photo dependencies, including old missing outcomes, before activation.

`plan` reads target metadata and reports missing immutable objects and declared bytes. `stage` imports exact documents, receipts and historical rows and copies only missing archive hashes. It never selects the native authority. An interrupted stage can resume with the same pinned inputs. A final source snapshot may advance an untouched staged head using `previousImportSha256`. This refuses overwriting native edits and supports retry after interruption.

`verify` compares every supplied current state document, selected original receipt and historical row, checks collection totals, reads back the declared archive objects, and compares the loaded report and GPS queries. It reports live and backup-only counts separately. Its result is `staged-data-verified` with `activationPending` and `archiveClosurePending`. This is deliberately a partial check. A supplied object list cannot establish that it includes every historical photo, GPS window, grading receipt and review-linked snapshot. The command never creates an activation parity receipt. Complete closure and the normal staff, grader and saved-source journeys must be independently established from the preserved roots before calling `verifyDriverAuditMongoAuthority`.

Use the [complete read-only parity operator and proof contract](native-parity.md) to bind an independently audited final source closure to the exact original/native records, contexts and physical bytes. It can reuse the completed CLI's full object-byte iteration only with its exact implementation pin and matching native file/chunk metadata captured before and after that pass. Final-window runs keep record/review/census comparisons fresh and clearly identify reused byte attestations. This operator does not update or activate native authority.

### Final authority handoff

Leave the existing authority serving during staging. Complete the handoff in this order:

1. Finish the exact Linux source/builder qualification, complete dependency closure checks and isolated staff read/save/retry/reload acceptance before opening the short activation window.
2. Fence old collector/grader admissions and **all old review-write endpoints**, then drain admitted work. Stop the old processes where that control is available, or use the native-only database capability proof described under [cutover evidence](#cutover-evidence). That mode proves the audited reporting capabilities are closed while old schedules may still invoke; it does not claim those processes stopped. Review saves do not use the collector lease. Include old report reads that can still change accounting heads. Pause the managed report sync, verify its worker/shared-work critical sections have drained, and freeze its current/previous/workspace roots. A PM2 stopped status alone is not the complete writer fence.
3. Take and independently restore-check a fresh final backup after stopping those writers. Recollect the complete actual target collector-root census under the fence. Import the final snapshot, receipts and required evidence delta. Compare exact results, photos, GPS, every review/household namespace and original missing outcomes; retain all backup objects.
4. Call `verifyDriverAuditMongoAuthority` with the exact import and an independently computed complete preservation result. Its `verifyResults` callback must establish result, GPS, photo and review-history equality. The partial migration CLI result cannot supply that proof. The function binds parity to the native write fence; a later staged write invalidates it.
5. Call `activateDriverAuditMongoAuthority` with the exact import/parity hashes and verified old collector/review fences, drained leases and final-backup clock. Activation requires no intervening native writes and a fresh window of at most 30 minutes. If the window expires, prepare fresh verified evidence rather than changing its recorded clocks.
6. Persist `mongo` consistently in the app and recovered source configuration, with the explicit native allowance in the app environment. Restart the API and managed sync so their process-start backends agree. Start the source through the exact release proof and initial cursor in the cutover controls. Preserve the direct serving generation and its retained packages.
7. Complete the [live data-flow acceptance checks](maintenance-map.md#verify-live-data-flow): observe changed source evidence, a new direct report publication, original photo bytes, dated GPS, a completed grade, and staff review/history behavior through the app and reload. Startup readiness alone leaves acceptance pending.

To verify native selection, check the actual database's `driverAuditNativeControl` authority for `status: active`, `verified: true`, pinned import/parity hashes and both old-writer fences. Check the effective app, sync and source configuration as well. Production backend initialization rejects a staged or unverified authority. The report API's legacy `storage: hosted` label is not evidence of the selected backend.

Stopping the new source worker preserves native state and history. If native writes have occurred, rollback must retain native authority until those new reviews, grades and collector changes have been reconciled and verified into the prior authority. Changing the environment back alone would expose an older journal. Keep the encrypted original backup and avoid archive deletion while final ownership, restoration or required historical links remain unresolved.

## Host and staging

Run the reviewed `Deploy to DigitalOcean` workflow on the exact deployed application commit. `audit-source-host-check` reports available Node executables, versions and required APIs, free memory and disk, the deployed commit, and the three managed process states. It performs read-only checks. Supply `source_node_executable` to inspect another absolute path. Qualify the exact Linux Node executable using source imports and isolated parity before activation. Record that executable and exact `process.version` in the source bundle.

The deployment workflow's source operations require its main ref and the deployed app to match the same reviewed SHA. When diagnostics-only commits put main ahead of the deployed app, use the reviewed `Driver Reports native handoff` workflow's `inspect` operation with `expected_deployed_sha` for target metadata and the actual collector census. That bridge also exposes `pause-builder` and `resume-builder` through the existing managed worker controls. These operations do not select native authority or constitute the final legacy writer/review fence. Use only explicitly implemented, reviewed operations; a diagnostic workflow's successful completion does not finish the migration.

For an existing local backup, `prepare-transfer` and `receive-transfer` in that workflow avoid downloading the same source archive again. Prepare accepts only public inventory totals, the exact target database/allowance and a temporary RSA public recipient in `transfer_plan_b64`. The host returns the signed Spaces upload URL and per-session AES key only inside a capsule encrypted to that recipient. Keep its private key, decrypted capability, original inventory and source locators outside GitHub. Encrypt from the verified backup, upload the exact ciphertext length, then receive with `transfer_session_id` and the exact deployed app SHA. Each authenticated frame binds the inventory, session, database and frame number; every file's size and content hash are checked before staging. No plaintext customer archive belongs in public workflow inputs, logs, artifacts or releases.

The receiver requires paused managed report writers, inactive native authority and a matching existing app database. It writes only immutable native evidence and owner-private migration inputs. Exact retries reuse saved inputs and native hashes; they do not select authority. After verified receipt it deletes only that session's newly created transient ciphertext from Spaces. Retain the encrypted original backup, inventories and completion receipts. A received transfer is staging evidence, not complete archive closure, parity, restoration or activation evidence.

After receiving metadata, `create-profile` builds the import profile from host-owned paths and the complete actual collector census. Its session must contain `profile-template.private.json` plus the seven pinned inputs: `documents.private.jsonl.gz`, `receipts.private.jsonl.gz`, `historical.private.jsonl.gz`, `objects.private.jsonl.gz`, `bookkeeping-backup.private.json`, `review-contexts.private.jsonl.gz` and `review-dependencies.private.jsonl.gz`. The template contains version 2, the explicit 16 GiB ceiling, `receiptInput` and `{file,sha256}` references; a forward delta also pins `previousImportSha256`. The operator derives the existing database, managed sync root and exact staged source runtime. The ceiling does not preallocate or request a 16 GiB copy.

Use `import_template_sha256` and the session UUID for creation/plan; pin the returned `import_profile_sha256` for `stage-import` and `verify-import`. The operator rejects changed roots, paths, inputs, source runtime or previous import. Already-ingested immutable objects are verified and reused, so the host needs no second loose archive tree. Full closure/parity and final authority activation remain separate. On a new source snapshot use a new verified metadata session and explicit prior import identity; preserve old profiles and proofs.

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

In native mode the public backend is the cache writer for staff, source and builder reads. The qualified private source delegates directly to its `managedReadCache` archive; the qualified private builder exports `supportsManagedArchiveCache` and accepts `skipCacheWrite` to bypass its old outer cache. Sync fails closed when either capability is absent. Every cache write rescans under a short shared OS lock, enforces the 512 MiB/8192-file bound and keeps 1 GiB of build headroom. Cache corruption, cancellation or unavailable space cannot substitute source evidence or change a transaction. The native execution budget also bypasses legacy hosting-cost counters while retaining bounded execution; it does not reset or bypass paid photo grading budgets, uncertain attempts or provider limits.

Staging writes `source.json` with the exact runtime, environment hash, executable and version. Worker activation uses the separate start operation. The initial cursor is supplied by the final cutover evidence. `audit-source-check` verifies these inputs and imports the three scheduled handler modules in isolated child processes.

## Qualify on the Linux host

Upload the reviewed replay fixture as a private, content-addressed `<SHA-256>.gz` archive object using the normal archive reservation and reader budget. The gzip JSON contains the staged source runtime manifest hash, a SHA-pinned saved-state document, the exact immutable archive keys and lengths needed by the saved replay, and the previously verified output counts and hashes. The source qualification allows a 1 MiB compressed fixture and at most 112 MiB of declared archive objects. Keep the fixture and the local replay receipt private.

Run `audit-source-qualify` with the deployed application commit, source manifest, source Node executable and `audit_source_qualification_sha256`. Leave the existing source schedules running until the cutover fence and leave the new source process stopped. The operation holds the shared heavy-work lock so the online sync process can wait without overlapping the rehearsals.

The qualification runs the exact recovered collector request through the app adapter against the saved capture. It verifies failure recovery, duplicate detection and the preserved row, photo grade, history and archive output fingerprints. The builder uses the pinned deployed code, renderer, validation journals, Node executable and heap settings. Its candidate lives in a temporary private workspace. The builder uses its archive-backed baseline and verifies immutable objects from the original local cache or ordinary budgeted archive reads. The isolated processes get no production credentials. Application-level network calls are restricted to the saved replay transport and the parent only obtains bounded verified archive reads. Legacy qualification records remote downloads in its reader ledger. Native qualification uses fixed host admission and preserves the saved legacy hosting ledgers unchanged.

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

The existing stopped-process fence requires `writersStopped: true`, `leasesDrained: true`, the release's `initialCursor` and a covering `validUntil`. Native `mongo` configuration also accepts `mode: "reporting-database-capability-v1"` with `writersStopped: false`: old cron requests may still execute and fail admission. This mode pins `id`, `sourceProjectRef`, the old `legacyRuntimeSha256`/`legacyEntrypointsSha256`, `admissionBlockedAt`, `checkedAt`, the matching cursor and expiry, plus independent `{id,path,sha256}` references named `capabilityAudit`, `drainAudit`, `quietAudit` and `checkpoint`. Each verified reference binds the same source, old runtime and admission barrier, its own ID, kind and observation clock. The capability audit identifies all 47 exact reporting function signatures, unchanged definition hashes, before/after ACL hashes and `beforeApiExecutableRoles`/`apiExecutableRoles`; all 26 mutator signatures and direct road-cache DML must be closed, the three owner-only internals must remain uncallable by API roles, all 21 preserved functions must retain their baseline effective roles and ACLs, reporting SQL-cron jobs 4/5 must be disabled, and unrelated ACLs and membership/auth access must be preserved. Audit owner-role bypass separately. Shared raw Storage/Gateway credentials remain outside this revocation. The drain audit identifies the admission-graph and owner audits and reports zero active reporting leases, transactions, SQL jobs, providers and privileged writers. Two independently identified quiet samples must match reporting-only `documents`, `receipts`, `archive`, `reservations`, `roadCache` and `capabilities` fingerprints over at least five minutes and at most 30 minutes after closure. Exclude operational GPS producer and Gallabox data. A later final checkpoint binds those fingerprints, collector/review revisions and exact release backup/parity hashes. The independently pinned backup receipt supplies `uncertainAttemptsBaseline: {count,sha256,snapshotId,sourceSnapshotSha256,restoreVerificationSha256}` from the actual restored source snapshot. Both drain and checkpoint before/after attempt counts and hashes must equal that baseline; the checkpoint also binds its snapshot and restore identities. Zero active provider work does not resolve or refund the five old uncertain attempts. The cursor is the last UTC minute already owned by the old scheduler. Fence, quiet and final-checkpoint evidence must be at most 30 minutes old at the supplied verification time, and the release activation window remains at most 30 minutes; restart checks may deliberately use the recorded successful activation instant. Create these proofs from the actual final fence, drain and checkpoint after staging and qualification; proposals or pre-staging snapshots cannot satisfy them.

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

Local tests are `node --test services/driverAuditSource.test.js services/driverAuditSourceDeployment.test.js services/driverAuditSourceStage.test.js services/driverAuditHeavyWork.test.js` from `server/`. Run the complete `npm test` suite as well. See the [maintenance test map](maintenance-map.md#run-the-relevant-checks) for native database, serving, client and upstream GPS checks, and keep fixture, host and live acceptance results separate.
