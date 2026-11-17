# Driver Reports maintenance map

Use this guide to trace and maintain Driver Reports in the Sidi delivery app. It maps the maintained components, staff and machine touchpoints, private release inputs, storage, configuration and verification. Use the [source-worker guide](source-worker.md) for the native handoff and source process controls, and the [builder replacement guide](builder-transition.md) for builder swaps and rollback.

**Native migration acceptance remains pending.** This map describes the implemented components and intended native mode. Verify actual authority, effective process configuration and the live journey before claiming activation. Keep production receipts and private evidence outside this public repository.

## Components and source ownership

The data path is `operational delivery/GPS inputs → source capture and assessment → retained evidence/state → direct report build/import → staff report and saved reviews`. Staff reads retain the last verified report while capture or publication is pending. Source requests read operational APIs; report grades and reviews do not update operational delivery status or establish physical handover.

Use these entry points to locate each component:

| Component | Maintained entry points | Runtime or release input |
| --- | --- | --- |
| Staff navigation and shell | [App.js](../../client/src/App.js), [Layout.js](../../client/src/components/Layout.js), [DriverReports.js](../../client/src/pages/DriverReports.js) | Protected React route and same-origin frame; per-user filters, account changes, reconnect and unsaved drafts. |
| Staff session and serving middleware | [driverAuditAuth.js](../../server/services/driverAuditAuth.js), [driverAuditIntegration.js](../../server/services/driverAuditIntegration.js) | `matter-delivery-api`; mounted in `server.js` before normal JSON parsing because it owns its raw bodies and security headers. |
| Serving adapter | [preview-runtime.mjs](../../server/vendor/driver-audits/integration/cloud/preview-runtime.mjs), [cloud-http.mjs](../../server/vendor/driver-audits/integration/cloud/cloud-http.mjs), [report-service.mjs](../../server/vendor/driver-audits/integration/cloud/report-service.mjs), [runtime-manifest.json](../../server/vendor/driver-audits/runtime-manifest.json) | Tracked `server/vendor/driver-audits`; frozen package reads, evidence, reviews, maps and renderer integration. |
| Source supervisor | [driverAuditSource.js](../../server/scripts/driverAuditSource.js), [source controls](../../server/scripts/driverAuditSourceDeploy.js), [scheduler/configuration](../../server/services/driverAuditSource.js) | Separate `matter-driver-audit-source` PM2 process. Private `source.json` pins runtime, environment, executable and release proofs. |
| Scheduled source implementation | Private runtime `source/api/collector.mjs`, `source/api/morning-gps.mjs`, `source/api/private-validation.mjs` and their declared dependencies | Separate owner-private source export; not the tracked serving-adapter tree. |
| Direct report sync | [driverAuditSync.js](../../server/scripts/driverAuditSync.js), [tick behavior](../../server/services/driverAuditSync.js), [direct import](../../server/services/driverAuditDirectImport.js), [writer](../../server/services/driverAuditWriter.js), [build recipe](../../server/services/driverAuditBuildRecipe.js) | Separate `matter-driver-audit-sync` PM2 process; one-minute tick, pinned build, candidate validation and serving-pointer transition. |
| Builder and renderer | Private `sync.json.codeRoot` loads `integration/cloud/automatic-release.mjs`, `automatic-release-source.mjs`, `automatic-release-build.mjs` and `scripts/run-automatic-report.mjs`; [renderer loader](../../server/services/driverAuditStaffRenderer.js) | Builder code, baseline, validation journals and renderer have independent fingerprints. The React shell is not the generated report renderer. |
| Backend and native preservation | [backend](../../server/services/driverAuditDataBackend.js), [RPC](../../server/services/driverAuditMongoRpc.js), [archive](../../server/services/driverAuditMongoArchive.js), [import/authority](../../server/services/driverAuditMongoImport.js), [review contexts](../../server/services/driverAuditReviewContexts.js), [technical recovery](../../server/services/driverAuditTechnicalState.js) | Dedicated native state/evidence collections in the existing app MongoDB; production opening requires verified active authority. |
| Native cache and execution admission | [read cache](../../server/services/driverAuditReadCache.js), [fixed host admission](../../server/services/driverAuditFixedHostBudget.js) | Immutable reads share a bounded private disk cache. Native execution retains concurrency/time/identity bounds while separate paid grading budgets and uncertain calls remain binding. |
| Encrypted backup transfer | [transfer operator](../../server/scripts/driverAuditNativeTransfer.js), [sessions](../../server/services/driverAuditTransferSession.js), [codec](../../server/services/driverAuditTransferCodec.js) | Reviewed main-only SSH operation; transient ciphertext in existing Spaces, authenticated immutable writes into MongoDB and owner-private inputs. Does not activate authority. |
| Actual target import controls | [import operator](../../.github/scripts/driver-audit-native-import.mjs), [migration CLI](../../server/scripts/driverAuditMongoMigrate.js), [collector census](../../server/services/driverAuditLiveImport.js) | Builds profiles from verified private transfers and real managed paths; separate plan/stage/verify, exact source and profile pins, inactive authority and before/after root checks. |
| Serving replica and retention | [replica](../../server/services/driverAuditReplica.js), [garbage collection](../../server/services/driverAuditGarbageCollection.js), [retention qualification](../../server/services/driverAuditRetention.js), [workspace retirement](../../server/services/driverAuditWorkspaceRetirement.js) | Separately bounded disposable serving bytes and current/previous roots; not source evidence retention. |
| Operational GPS producer | [recordVehicleLocations.js](../../server/jobs/recordVehicleLocations.js), [capture](../../server/services/vehicleLocationCapture.js), [capture store](../../server/services/vehicleLocationCaptureStore.js) | Runs inside the API independently of report schedules. Retains original response/fix/capture clocks and explicit outcomes. |

The tracked vendor tree is self-contained for serving, but the complete scheduled source and builder implementations are separate private exports. Some overlapping source/serving paths differ; copying one tree over the other can replace the wrong implementation. The private source also contains business identity configuration that cannot be copied unchanged into this public repository. Renderer exports can contain private captured material.

**Source ownership gap:** before rebuilding a private export, identify its durable versioned source owner and reproducible export procedure from the private release record. A local staged runtime or backup alone does not provide that maintenance owner. Record the Git revision, export manifest and private input references separately. Keep this gap explicit until code/private-input separation and a documented versioned export path exist; never infer complete source ownership from `runtime-manifest.json`.

## Staff routes and permissions

Allowed roles are `super_admin`, `admin`, `manager`, `dispatcher` and `viewer`; non-super-admin users also need effective `reports` permission. The first four become reporting `reviewer`; `viewer` stays read-only for human findings. Staff report cookies/CSRF, external API keys, cron authorization and Gateway identity are separate schemes.

The app's [Activity history](../traceability/README.md) retains the authenticated Matter account name, account ID and original staff role alongside request activity. The report session preserves its existing reporting actor and authority. An accepted reporting request is not labelled a confirmed database save by this cross-app history; the report's own immutable review journal confirms the saved review. Browser capture in the parent app does not observe unsaved controls inside the report frame.

The [integration](../../server/services/driverAuditIntegration.js) authenticates report routes before dispatching to [cloud-http.mjs](../../server/vendor/driver-audits/integration/cloud/cloud-http.mjs):

| Route and method | Purpose | Persistence or compatibility boundary |
| --- | --- | --- |
| `GET /driver-reports` | Staff SPA shell and report frame | Protected by `reports` permission. |
| `GET /driver-audits` | Redirect to `/driver-reports` | `/reports` remains the separate operational reports page. |
| `POST /api/driver-audits/session` | Uses existing staff Bearer sign-in to issue report cookie | Same origin, JSON and `X-Driver-Audit-Client: reporting-v1`; an incompatible old service worker receives 428. |
| `DELETE /api/driver-audits/session` | Clears report cookie on logout | [authSlice.js](../../client/src/store/slices/authSlice.js) and shell draft handling own the client side. |
| `GET, HEAD /api/session`; `POST /api/session/refresh` | Checks the staff report session | Sidi bypasses the old hosted Supabase login/request-code flow. |
| `GET, HEAD /api/reporting/view`; `/driver-audit-view` | Report HTML | `staffFrame=1` selects the same-origin embedded presentation. |
| `GET, HEAD /api/reporting/status` | Report/source identities, CSRF token and bounded sync health | The legacy `storage: hosted` display field does not identify the selected data backend. |
| `GET, HEAD /api/reporting/reviews`; `POST /api/reporting/reviews` | Reads or appends saved findings | POST needs reviewer/CSRF, exact snapshot/issue, expected revision, event ID and verified actor. Retry/conflict semantics preserve history. |
| `POST /api/reporting/reviews/migrate` | Empty-client compatibility read | Supplied nonempty review history is rejected, not imported. |
| `GET, HEAD /api/reporting/delivery-identities` | Pinned identity view | POST is rejected by the frozen staff identity adapter. |
| `GET, HEAD /api/reporting/gps-evidence`; `/api/reporting/road-evidence` | Snapshot/record-bound GPS or display evidence | Missing GPS remains missing; road geometry does not prove a visit. |
| `POST /api/reporting/maps/access` | Map capability/budget admission | Session and CSRF protected; technical allowance writes are separate from human reviews. |
| `GET, HEAD /api/reporting/evidence-overlay` | Generation-bound validated overlay | Stale generation and missing evidence remain explicit. |
| `GET, HEAD /api/reporting/completed`; `/api/reporting/photo-proposals` | Completed state and paged photo findings/proposals | A proposal-page count does not download unrelated image archives. |
| `GET, HEAD /api/reporting/photo`; `/api/reporting/photo/image` | Photo metadata or original bytes bound to `record` and `snapshot` | Checks hashes/bindings; unavailable, unbound and corrupt inputs do not become successful evidence. |
| `GET, HEAD /report-data/{detail,history,query,archive,snapshot}-HASH.json` | Generation-bound data and history | `/api/reporting/report-data/...` aliases use the same rules. Unavailable retired generations return 409; missing retained evidence remains an availability error. |
| `GET, HEAD /report-assets/font-HASH.{woff,woff2,ttf,otf}` | Hash-checked packaged fonts | `/api/reporting/report-assets/...` aliases remain staff protected. |
| `POST /api/reporting/fresh-run`; `/api/reporting/api-refresh` | Generic handler names | Not enabled by the frozen Sidi staff feed. Opening/reading the report does not start source jobs. |

`POST /api/session` and `POST /api/session/request-code` belong to the legacy hosted login flow. Sidi rejects the former through its staff-session middleware and does not mount the latter as a report login endpoint.

The [service worker](../../client/public/service-worker.js) and [worker compatibility check](../../client/src/utils/driverAuditWorker.mjs) keep session, report evidence/data and asset paths network-only. Preserve this boundary and account/draft handling when changing navigation or reconnect behavior.

## Source schedules and upstream inputs

The supervisor invokes the following request identities as child functions; they are **not Express routes mounted on Sidi**. Each job retains its original request method/path, cron authorization and a 300-second maximum. Exact active schedules come from the pinned source manifest. The recovered schedule set uses UTC; delivery-day boundaries use Dubai time.

| Request identity | UTC cron schedule | Source outcome |
| --- | --- | --- |
| `GET /api/collector?task=delivery` | `0,30 0-7 * * *`; `55 9,11,13,15,17,19 * * *`; `0,15,30,45 20-23 * * *` | Reconciled delivery capture and source photo input. |
| `GET /api/collector?task=delivery-history` | `1 4,16 * * *` | Configured history capture/reconciliation. |
| `GET /api/collector?task=gps` | `7 6-19 * * *` | Configured GPS-window capture. |
| `GET /api/collector?task=gps-publish` | `8-58/10 * * * *` | Retained GPS evidence/assessment publication. |
| `GET /api/collector?task=photo-grade` | `4-59/5 * * * *` | Bounded queued grading with binding and uncertain-call recovery. |
| `GET /api/collector?task=photo-backlog` | `6-56/10 * * * *` | Retained photo backlog work. |
| `GET /api/morning-gps` | `2,12,22,32,42,52 0-5 * * *`; `2,12,22,32,42,52 20-23 * * *`; `2 6 * * *` | Morning capture/window recovery. |
| `GET /api/private-validation` | `12,27,42,57 0-7 * * *`; `12 8-23 * * *` | Assignment/GPS/private validation; its entry imports the assignment-GPS runtime. |

Other private export modules, including `api/index.mjs`, `api/qualify.mjs` and `api/qualify-publication.mjs`, are not these scheduled Sidi routes. Keep old hosted write endpoints fenced during native ownership.

The source uses these operational touchpoints:

| Input | Owner and contract |
| --- | --- |
| `GET /api/external/deliveries` | [externalDeliveryApi.js](../../server/routes/externalDeliveryApi.js): static-key, paginated Dubai-day enumeration. The source bounds pages/bytes, rejects duplicates/drift, reconciles totals and archives response provenance. The API's `GET /:id` is separate from that enumeration. |
| `GET /api/external/drivers/locations` | [externalDriverLocationApi.js](../../server/routes/externalDriverLocationApi.js): last-known driver/vehicle observations. |
| `GET /api/external/drivers/locations/history` | Same router: recorded dated GPS and mapping evidence; missing history is not fetched or invented on this read path. |
| `GET /api/external/drivers/locations/capture-status` | Same router: operator view of recorded capture outcomes, not proof of continuous coverage. |
| Original photo URLs and retained archive | Existing delivery uploads plus private source `cloud-photos.mjs`: original read switches, bounded bytes, image hashes and delivery binding remain in force. |
| Qualified model provider | Source grader/Gateway identity: model eligibility/pricing, limits, reservation/settlement and uncertain-call handling remain binding. |

See [the external API guide](../EXTERNAL_DELIVERY_API.md) and [apiKeyAuth.js](../../server/middleware/apiKeyAuth.js). The source consumer's `MATTER_DELIVERY_API_KEY` is distinct from staff JWT and cron authorization. Operational delivery creation/import, driver offline status/photo uploads and Truckoom recording remain their own workflows.

## Stores, caches and locks

Use these groups when tracing persistence or planning recovery:

| Store | Contents and boundary |
| --- | --- |
| `driverAuditNativeDocuments`, `driverAuditNativeReceipts` | Exact heads and protected original receipt/event/revision/request clocks. Includes collector state, grades and every review/household namespace. |
| `driverAuditNativeHistorical` | Original delivery, issue, retained-row, run and private-response rows. |
| `driverAuditNativeFiles`, `driverAuditNativeChunks`, `driverAuditNativeControl` | Immutable evidence/chunks, quota and verified authority; not disposable caches. |
| `driverAuditNativeReviewContexts`, `driverAuditNativeReviewFiles` | Original review-linked snapshot/photo dependencies with provenance and original missing outcomes. |
| `driverAuditNativeLeases` | Collector and qualification writer ownership/fences; does not fence human review saves. |
| `driverAuditNativeArchiveControl`, `driverAuditNativeArchiveLedger`, `driverAuditNativeReservations`, `driverAuditNativeConsumption` | Archive allowance/reservation/operation identities. Only verified released reservation/operation records receive the documented limited expiry. |
| `driverAuditNativeTechnicalRecords`, `driverAuditNativeTechnicalChunks` | Bounded recent technical retry recovery. Its reclamation does not prune photos, GPS, grades or human/source history. |
| `driverAuditNativeRoadCache` | Disposable road geometry with its existing expiry; separate from raw GPS evidence. |
| `driverAuditObjects`, `driverAuditControl`, `driverAuditReleases` | Direct serving replica, current/previous roots, staged import, writer/status and release metadata; separate quota and qualified reclamation. |
| Private source release root | `server/.private/driver-audit-source/MANIFEST/`: pinned runtime/environment, proofs, scheduler queue/cursor and status. |
| Private managed sync root | `server/.private/driver-audits/MANIFEST/`: `sync.json`, builder, baseline, validation journals, current/previous workspaces and recovery receipts. |

`collector-state`, `worker-config`, grading/recovery checkpoints and every original review/household journal retain their own provenance. The Sidi review namespace is `preview-gps-map-20261106:`. Namespace names do not make human history disposable; preserve other original namespaces too.

The source and sync share a hash-verified disk archive cache capped at 512 MiB, subject to the build reserve. Serving repository/evidence memory caches, browser read caches and GPS stream caches are bounded derived copies. A cache hit is not independent proof that a missing native original exists. Native missing/corrupt objects fail visibly without fetching from Supabase. Keep independently verified backup metadata **and object bytes** outside these caches and serving-replica retention.

[driverAuditHeavyWork.js](../../server/services/driverAuditHeavyWork.js) uses `server/.private/driver-audit-heavy-work` to serialize heavy source children and full sync ticks. Source and sync also have separate OS-backed worker locks; source controls have a deployment lock. Preserve their acquisition/drain paths. A stopped supervisor or a remote collector lease alone does not prove that every in-flight review, source child or serving-root update has finished.

## Configuration owners

Keep values private. Check names and effective settings at each process boundary:

| Owner | Settings |
| --- | --- |
| Existing server | `MONGODB_URI`, `JWT_SECRET`; [loadEnv.js](../../server/loadEnv.js) loads `.env` first and `.env.local` overrides before other app imports. |
| Serving/direct sync | `DRIVER_AUDIT_ENABLED`, `DRIVER_AUDIT_IMPORT_ENABLED`, `DRIVER_AUDIT_ORIGIN`, `DRIVER_AUDIT_CAPACITY_BYTES`, `DRIVER_AUDIT_REPLICA_GC_ENABLED`. Direct sync keeps the old publication importer disabled; serving capacity is separately bounded. |
| Native selection | `DRIVER_AUDIT_DATA_STORE`, `DRIVER_AUDIT_NATIVE_CAPACITY_BYTES`. App/sync/source must agree on the selected store; the app owns URI and native quota. |
| Legacy transport compatibility | `DRIVER_AUDIT_SUPABASE_SECRET`, `MATTER_SUPABASE_SECRET`. Native code uses injected native transports; keep the recovered source's declared input contract until a qualified change removes an input. |
| Private source environment | `CRON_SECRET`, `MATTER_DELIVERY_API_KEY`, `MATTER_DELIVERY_ENABLED`, `MATTER_PHOTO_READ_ENABLED`, `MATTER_PHOTO_GRADE_ENABLED`, `MATTER_GPS_ENABLED`, `MATTER_GPS_PUBLICATION_ENABLED`. Preserve disabled switches/scope; its native declaration excludes app URI/quota. |
| Grading and source cache | `AI_GATEWAY_API_KEY`, `MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY`. The supervisor supplies the qualified grading identity through the original handler header. Persisted OIDC tokens are rejected. Cache path must match the managed builder. |
| Renderer/map display | `DRIVER_AUDIT_STAFF_RENDERER_DIR`, `DRIVER_AUDIT_STAFF_RENDERER_SHA256`, optional `MATTER_PREVIEW_ROADS_KEY`; captured map configuration and renderer bytes have separate private provenance. |
| GPS producer | `VEHICLE_LOCATION_RECORD_INTERVAL_MS` and existing Truckoom configuration; polling cadence does not establish GPS-fix cadence. |
| Operator controls | Exact `DRIVER_AUDIT_DEPLOY_*`, `DRIVER_AUDIT_SOURCE_*`, builder identities and staff/restore/release proof references. Workflow secret envelopes and private profiles are not browser configuration. |

The app caches its integration context and sync opens its backend at process start. A shell export alone does not switch all running processes. Verify persisted configuration, the actual native authority and restarted process behavior; do not infer a switch from an accepted workflow request or report presentation label.

## Safe operating entry points and recovery

Use the exact deployed app SHA and reviewed inputs. The workflows share `production-deploy` serialization:

- [Native handoff bridge](../../.github/workflows/driver-audit-native-handoff.yml): inspect actual target/census, or pause/resume the managed builder through its existing controls. Main's diagnostics revision can differ from the explicit deployed app SHA. These choices do not activate native authority.
- [Deploy/source controls](../../.github/workflows/deploy-digitalocean.yml): existing explicit source stage/check/qualify/start/pause/resume/rollback and builder/serving release operations. Its source-operation guards require the reviewed main/deployed commit to agree. Follow [source cutover evidence](source-worker.md#cutover-evidence).
- [Sync diagnostics](../../.github/workflows/audit-sync-status.yml): use only the explicit reviewed diagnostic/maintenance choice; some choices mutate derived workspace state. Read the helper and its accepted operation before dispatching.
- [Native migration CLI](../../server/scripts/driverAuditMongoMigrate.js): `plan`, `stage`, `verify` with an absolute owner-private profile and its SHA-256. [Receipt selection](../../server/scripts/driverAuditSelectReceipts.js) preserves backup-only bookkeeping separately. CLI inventory verification leaves complete archive closure and activation pending.

Follow the [final authority handoff](source-worker.md#final-authority-handoff): finish expensive preparation first; stop/drain legacy source and all review writers; freeze sync roots; restore-check a fresh final backup/delta; prove complete preservation; activate under the fresh dual fence; persist one backend; restart/verify app and workers; then complete live acceptance. A public repository must not receive private plaintext exports in commits, logs, artifacts or releases. Use the established owner-private transfer/proof paths.

Source rollback stops/drains its process and marks the source receipt; it does not reconcile native edits into Supabase. Full `audit-rollback` disables report access and removes sync registration; it is not a pause or a reverse native migration. After native semantic writes, retain native authority and newest journals until all new reviews, grades and collector changes are reconciled into any proposed prior authority. Preserve original encrypted backups and required historical links. See [builder rollback](builder-transition.md) for restoring builder code while retaining a newer verified report.

## Verify live data flow

Keep a private acceptance receipt that binds the deployed app, source/config/environment, Node, builder/renderer and authority identities. Distinguish implementation fixtures, Linux host qualification and these actual production observations:

1. Verify native authority and effective app/sync/source settings using the [handoff checks](source-worker.md#final-authority-handoff). Confirm old writer/review fences remain in effect and the new source heartbeat reflects its exact configuration. A ready heartbeat proves startup, not collection.
2. Trace an actual completed delivery capture through its source observation clock, reconciled pages/counts, immutable response hashes and saved source revision. Preserve provider time, upload time, GPS-fix time, capture time, build/publication time and staff-visible cutoff separately.
3. Observe **changed evidence** advance the source basis and produce a validated direct report publication with a matching current serving pointer. Open the report in the Sidi staff app and reload it. An unchanged capture correctly keeps the existing generation while sync updates `latestCaptureAt`; that alone does not prove a new report was built.
4. Open the changed delivery's original photo and dated GPS evidence through the staff APIs. Check image hash/record/proof binding, GPS source/window/assignment identity and original missing outcomes. Verify originals from the selected backend rather than relying only on warm cache bytes. Neither a vehicle position nor a destination pin proves handover.
5. Observe an eligible new image reach a completed grade with matching image/binding, durable result receipt and budget settlement, then appear in the published report. Accepted, uncertain, deferred or failed provider work remains pending; do not blindly repeat uncertain inference.
6. Confirm original review/household history survives publication and reload. Prove new save, lost-acknowledgement retry, stale conflict and restart in isolation. Production exact-event retry requires the original verified actor and exact request; a genuine authorized staff response can prove a new production save. Never append a fabricated finding to a real customer's immutable history.
7. Check the next duplicate/no-change capture preserves results/history without unnecessary regrading or derived report publication. Verify approved pause/restart recovery retains pending work and the last verified report. Keep backups and newest native edits throughout recovery.

For an Activity history release, also check that a real authorized report request retains the original staff account identity while its canonical saved-review actor/history and permissions remain unchanged. This live identity check is pending; local auth, integration and offline fixtures do not establish production acceptance.

Record each result and unresolved gap. A report displaying only its pre-activation capture, a source-only success, or a passing fixture suite does not complete this journey.

## Run the relevant checks

Run targeted checks for the changed component, then the repository's required checks. These commands run from `server/`:

```sh
node --test services/driverAuditSource.test.js
npm test
```

Select related files from this test map:

| Changed area | Server tests under `server/services/` |
| --- | --- |
| Staff auth/routes/evidence/offline/renderer | `driverAuditAuth.test.js`, `driverAuditIntegration.test.js`, `driverAuditOffline.test.js`, `driverAuditStaffRenderer.test.js`. |
| Source schedule/stage/process/host binding | `driverAuditSource.test.js`, `driverAuditSourceStage.test.js`, `driverAuditSourceDeployment.test.js`, `driverAuditSourceQualification.test.js`, `driverAuditHeavyWork.test.js`. |
| Native import/RPC/archive/history | `driverAuditLiveImport.test.js`, `driverAuditSelectReceipts.test.js`, `driverAuditMongoImport.test.js`, `driverAuditMongoRpc.test.js`, `driverAuditMongoArchive.test.js`, `driverAuditMongoText.test.js`, `driverAuditReviewContexts.test.js`. |
| Native caching, admission and backup transfer | `driverAuditReadCache.test.js`, `driverAuditFixedHostBudget.test.js`, `driverAuditTransferCodec.test.js`, `driverAuditTransferSession.test.js`. |
| Direct sync/build/retention/recovery | `driverAuditSync.test.js`, `driverAuditDirectImport.test.js`, `driverAuditDeployment.test.js`, `driverAuditBuilderTransition.test.js`, `driverAuditBuildRecipe.test.js`, `driverAuditGarbageCollection.test.js`, `driverAuditWorkspace.test.js`, `driverAuditWorkspaceRetirement.test.js`. |

Database tests need an isolated transaction-capable `MONGO_TEST_URI`; skipped database cases are not database verification. Source supervisor fixture tests use synthetic handler modules, so they do not replace exact private-source replay, credential qualification or Linux memory/disk acceptance. Upstream GPS changes also need the capture/store and `server/routes/externalDriverLocationApi.test.js` checks described in [GPS database review](../GPS_DATABASE_REVIEW.md).

For import-control changes, run `node --test .github/scripts/driver-audit-native-import.test.mjs` from the repository root. Its fixtures cover the encrypted session, private input pins, actual target/worker/root guards, plan/stage/verify dispatch and failure cleanup. They do not import production data or establish production parity.

For staff shell changes, run these commands from `client/`:

```sh
CI=true npm test -- --watch=false --runInBand \
  --runTestsByPath src/pages/DriverReports.test.js
npm run build
```

Finally verify the affected browser and live journey, including reload, failure and recovery. For documentation-only edits, check referenced files/anchors, route/config names and public/private boundaries; no application fixtures or production operations are needed.
