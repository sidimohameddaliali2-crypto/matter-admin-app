# Driver Reports source worker

The Sidi source worker runs the recovered collector, morning GPS and private-validation handlers in a separate PM2 process named `matter-driver-audit-source`. The existing report builder remains `matter-driver-audit-sync`. Both use the existing source database, archive, journals, budgets and publication rules.

The source runtime and credentials live under `server/.private/driver-audit-source/<manifest SHA-256>/`. Keep this directory owner-only, with directory mode `0700` and file mode `0600`. The application repository contains the supervisor and its tests. The recovered source, source environment, saved checkpoints and evidence receipts stay private.

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

Staging writes `source.json` with the exact runtime, environment hash, executable and version. Worker activation uses the separate start operation. The initial cursor is supplied by the final cutover evidence. `audit-source-check` verifies these inputs and imports the three scheduled handler modules in isolated child processes. Schedule and data parity, credential qualification, resource sizing and archive recovery require their separate evidence.

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
