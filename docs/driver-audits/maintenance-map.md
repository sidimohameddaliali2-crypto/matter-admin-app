# Driver Reports maintenance map

Use this guide to trace and maintain Driver Reports in the Sidi delivery app. It maps the maintained components, staff and machine touchpoints, private release inputs, storage, configuration and verification. Use the [source-worker guide](source-worker.md) for the native handoff and source process controls, and the [builder replacement guide](builder-transition.md) for builder swaps and rollback.

The selected release opens the date-indexed Supabase reader in Sidi’s current staff page and runs generation on a separate worker. Production acceptance remains pending. Follow [the in-app reader and separate worker path](source-worker.md#in-app-reader-and-separate-worker). The native import procedures document the parked MongoDB migration.

Use [historical source receipt retention](historical-source-lineage.md) when an old temporary report workspace is already missing. That proof selects the exact original source receipt and records the rendered-copy gap; it does not recreate or certify the missing workspace.

**Supabase handoff acceptance remains pending.** Verify the actual processes, serving pointer and live journey before claiming activation. MongoDB import, native authority and native archive instructions below describe parked compatibility code; they are not steps in the selected handoff. Keep production receipts and private evidence outside this public repository.

## Components and source ownership

The data path is `operational delivery/GPS inputs → source capture and assessment → Supabase evidence → delivery-scoped publication → staff report and saved reviews`. Staff reads retain the last verified report while capture or publication is pending. Source requests read operational APIs. Report grades and reviews describe recorded evidence and preserve the original delivery status.

Use these entry points to locate each component:

| Component | Maintained entry points | Runtime or release input |
| --- | --- | --- |
| Staff navigation and shell | [App.js](../../client/src/App.js), [Layout.js](../../client/src/components/Layout.js), [DriverReports.js](../../client/src/pages/DriverReports.js) | Protected React route and same-origin frame; per-user filters, account changes, reconnect and unsaved drafts. |
| Staff session and serving middleware | [driverAuditAuth.js](../../server/services/driverAuditAuth.js), [driverAuditIntegration.js](../../server/services/driverAuditIntegration.js), [report proxy](../../server/services/driverAuditReaderProxy.js), [report listener](../../server/services/driverAuditHttp.js) | Staff use the existing session and app origin. The Supabase reader prepares and renders reports in an app-managed child with a private loopback connection. Business requests stay in the main process. The child limits preparation to the current report and one other generation, and continues serving the current report while a historical request finishes. The stand-alone on-server listener uses port 5002. |
| Date-indexed reader | [page](../../server/services/driverAuditLightPage.js), [routes](../../server/services/driverAuditLightReader.js), [archive](../../server/services/driverAuditLightArchive.js), [case evidence](../../server/services/driverAuditLightEvidence.js) | The staff frame opens the date directory and one page of up to 40 deliveries. Driver selection reads only its relevant pages. The evidence pane loads the selected delivery, original GPS shards, photo and history on demand. Full report tools retain the saved renderer on an explicit link. |
| Original date index | [build](../../server/services/driverAuditLightBuild.js), [projection](../../server/services/driverAuditLightProjection.js), [original policy](../../server/services/driverAuditLightPolicy.js) | The one-time index uses the exact verified report, owner timing context and original review snapshot. The serving pointer retains this index and its original package. |
| Scheduled delivery publication | [comparison](../../server/services/driverAuditDeliveryChanges.js), [selected-case grading](../../server/services/driverAuditDeliveryCaseProjection.js), [publication](../../server/services/driverAuditDeliveryPublish.js), [case archive](../../server/services/driverAuditDeliveryView.js) | The 10:30 run builds unpublished delivery keys. Noon also checks material changes to previously published deliveries. The app opens an immutable case update when present and otherwise reads the original case. A publish verifies new objects and selects them through the existing Supabase pointer. |
| Case review history | [driverAuditLightReviews.js](../../server/services/driverAuditLightReviews.js) | Uses the original Supabase journal and review rules with a bounded transport. The selected case can show earlier evidence scopes. Current review saves retain the issue key, actor, revision and retry ID. Prior evidence scopes are read-only. |
| Automated photo suggestions | [driverAuditLightPhotoSuggestions.js](../../server/services/driverAuditLightPhotoSuggestions.js), [original result checks](../../server/vendor/driver-audits/integration/cloud/report-service.mjs) | The Photo pane opens the selected photo and its original automated suggestion. The one-time index stores a small lookup for historical queues, and result bodies stay in the existing archive. New suggestions come from the saved collector publication and must match the same delivery, upload URL, proof timestamp and photo bytes. Staff review decisions take priority over new suggestions. |
| Serving adapter | [preview-runtime.mjs](../../server/vendor/driver-audits/integration/cloud/preview-runtime.mjs), [cloud-http.mjs](../../server/vendor/driver-audits/integration/cloud/cloud-http.mjs), [report-service.mjs](../../server/vendor/driver-audits/integration/cloud/report-service.mjs), [runtime-manifest.json](../../server/vendor/driver-audits/runtime-manifest.json) | Tracked `server/vendor/driver-audits`; frozen package reads, evidence, reviews, maps and renderer integration. |
| Source supervisor | [driverAuditOffHostWorker.js](../../server/scripts/driverAuditOffHostWorker.js), [scheduler/configuration](../../server/services/driverAuditSource.js) | The separate worker invokes the pinned source at the two Dubai checks. Its `--once` option runs at most one eligible saved slot with the same enrollment, then exits. Private `source.json` pins runtime, environment and executable. `launch-verified.private.json` enrolls those exact inputs. The separate `matter-driver-audit-source` PM2 registration belongs to the on-server rollout. |
| Hosted worker preparation | [GitHub workflow](../../.github/workflows/driver-reports-worker.yml), [bootstrap check](../../server/scripts/driverAuditHostedBootstrap.js), [slot claims](../../server/services/driverAuditHostedSlots.js), [encrypted archive cache](../../server/services/driverAuditHostedCache.js) | Verify the private release inputs and claim the slot named by the GitHub cron trigger before source work. Confirm each actual slot from its Supabase terminal receipt. Authenticate disposable cache objects before restoring them. Run qualification and transport through the owner-controlled runner environment. |
| Scheduled source implementation | Private runtime `source/api/collector.mjs`, `source/api/morning-gps.mjs`, `source/api/private-validation.mjs` and their declared dependencies | Separate owner-private source export; not the tracked serving-adapter tree. |
| Direct report sync | [driverAuditSync.js](../../server/scripts/driverAuditSync.js), [Supabase runner](../../server/services/driverAuditSupabaseSync.js), [Supabase serving pointer](../../server/services/driverAuditSupabaseReplica.js), [build recipe](../../server/services/driverAuditBuildRecipe.js) | The off-host runner calls the delivery publisher for the [two Dubai slots](source-worker.md#daily-report-checks). Unchanged evidence keeps the same serving pointer and objects. The original import and compatibility builder run through their explicit release paths. |
| Builder and renderer | Private `sync.json.codeRoot` loads `integration/cloud/automatic-release.mjs`, `automatic-release-source.mjs`, `automatic-release-build.mjs` and `scripts/run-automatic-report.mjs`; [renderer loader](../../server/services/driverAuditStaffRenderer.js) | Builder code, baseline, validation journals and renderer have independent fingerprints. The React shell is not the generated report renderer. |
| Parked native backend and preservation | [backend](../../server/services/driverAuditDataBackend.js), [RPC](../../server/services/driverAuditMongoRpc.js), [archive](../../server/services/driverAuditMongoArchive.js), [import/authority](../../server/services/driverAuditMongoImport.js), [review contexts](../../server/services/driverAuditReviewContexts.js), [technical recovery](../../server/services/driverAuditTechnicalState.js) | Separate native state/evidence collections in the existing app MongoDB; not used by the selected Supabase report process. |
| Sidi execution with Supabase | [app backend](../../server/services/driverAuditSupabaseAppBackend.js), [archive/photo overlay](../../server/services/driverAuditSupabaseArchive.js), [HTTP transfer admission](../../server/services/driverAuditSupabaseTransfer.js) | Explicit Sidi host capability; canonical records/reviews stay in Supabase. Remote HTTP byte admission is below the shared cache and separate from old hosting money ledgers and paid grading. |
| Parked hybrid archive | [store factory and candidate lookup](../../server/services/driverAuditNativeObjectStore.js), [Spaces bytes/privacy/aliases](../../server/services/driverAuditSpacesArchive.js), [preingest controls](../../.github/scripts/driver-audit-native-object-store.mjs) | Separate native option for records/reviews in MongoDB and archive references in Spaces. The selected Supabase photo overlay uses the Spaces reader only to verify existing original uploads. |
| Delivery/GPS/validation poll progress | [typed lease-fenced progress](../../server/services/driverAuditPollProgress.js), [Supabase metadata migration](../../server/migrations/20261117103823_driver_audit_app_poll_progress.sql); private source `native-poll-progress.mjs`, `cloud-collector.mjs`, `gps-worker.mjs` and `private-validation.mjs` | Bounded retry/scheduling metadata; identical polls retain original capture/GPS/report identity. Source and builder manifests remain separate. The parked Mongo RPC implements the older native variant. |
| Managed cache and execution admission | [archive read cache](../../server/services/driverAuditReadCache.js), [collector read cache](../../server/services/driverAuditCollectorReadCache.js), [fixed host admission](../../server/services/driverAuditFixedHostBudget.js) | Owner-private shared cache with a 512 MiB ceiling and 1 GiB free-disk reserve. Collector reads always check Supabase's revision; unchanged heads reuse hash-verified bytes across child processes/restarts. Paid ledgers and other state remain uncached. Failed checks never serve an assumed unchanged head. |
| Encrypted backup transfer | [transfer operator](../../server/scripts/driverAuditNativeTransfer.js), [sessions](../../server/services/driverAuditTransferSession.js), [codec](../../server/services/driverAuditTransferCodec.js), [bounded download](../../server/services/driverAuditTransferDownload.js) | Reviewed main-only SSH operation; transient ciphertext in existing Spaces, authenticated immutable writes into MongoDB and owner-private inputs. Exact ranged responses pin length and ETag/version, close before Mongo work and retry bounded connection failures. Does not activate authority. |
| Actual target import controls | [import operator](../../.github/scripts/driver-audit-native-import.mjs), [migration CLI](../../server/scripts/driverAuditMongoMigrate.js), [collector census](../../server/services/driverAuditLiveImport.js) | Builds profiles from verified private transfers and real managed paths; separate plan/stage/verify, exact source and profile pins, inactive authority and before/after root checks. |
| Complete native preservation verification | [read-only parity operator](../../.github/scripts/driver-audit-native-parity.mjs), [proof contract](native-parity.md) | Binds the final independent source closure to exact current documents, receipts, history, reviews, original object bytes and actual bootstrap/census. Reuses only a complete code-pinned byte attestation with unchanged target/reference/chunk metadata; never changes authority. |
| Serving replica and retention | [replica](../../server/services/driverAuditReplica.js), [garbage collection](../../server/services/driverAuditGarbageCollection.js), [retention qualification](../../server/services/driverAuditRetention.js), [workspace retirement](../../server/services/driverAuditWorkspaceRetirement.js) | Separately bounded disposable serving bytes and current/previous roots; not source evidence retention. |
| Operational GPS producer | [recordVehicleLocations.js](../../server/jobs/recordVehicleLocations.js), [capture](../../server/services/vehicleLocationCapture.js), [capture store](../../server/services/vehicleLocationCaptureStore.js) | Runs inside the API independently of report schedules. Retains original response/fix/capture clocks and explicit outcomes. |

The tracked vendor tree is self-contained for serving, but the complete scheduled source and builder implementations are separate private exports. Some overlapping source/serving paths differ; copying one tree over the other can replace the wrong implementation. The private source also contains business identity configuration that cannot be copied unchanged into this public repository. Renderer exports can contain private captured material.

The [private source maintenance guide](private-source-maintenance.md) explains complete source/builder recovery, actual revision identification and qualification. For the selected path, retain the complete Sidi staged trees and independently read back their private Supabase or recovery-backup code envelopes; actual staging/recovery receipts remain pending until that host operation completes. Native code-archive recovery is a parked alternative. A local working copy or `runtime-manifest.json` alone is insufficient to declare ownership complete.

## Staff routes and permissions

Allowed roles are `super_admin`, `admin`, `manager`, `dispatcher` and `viewer`; non-super-admin users also need effective `reports` permission. The first four become reporting `reviewer`; `viewer` stays read-only for human findings. Staff report cookies/CSRF, external API keys, cron authorization and Gateway identity are separate schemes.

The business app's [Activity history](../traceability/README.md) retains its authenticated account identity. The selected isolated report listener does not mount that general request-activity sink. Keep actual saved reviews and their original actors in the report's immutable Supabase journals. An accepted request is not proof of a saved review; browser capture in the parent app does not observe unsaved controls inside the report frame.

The [integration](../../server/services/driverAuditIntegration.js) authenticates report routes before dispatching to [cloud-http.mjs](../../server/vendor/driver-audits/integration/cloud/cloud-http.mjs):

| Route and method | Purpose | Persistence or compatibility boundary |
| --- | --- | --- |
| `GET /driver-reports` | Staff SPA shell and report frame | Protected by `reports` permission. |
| `GET /driver-audits` | Redirect to `/driver-reports` | `/reports` remains the separate operational reports page. |
| `POST /api/driver-audits/session` | Uses existing staff Bearer sign-in to issue report cookie | Same origin, JSON and `X-Driver-Audit-Client: reporting-v1`; an incompatible old service worker receives 428. |
| `DELETE /api/driver-audits/session` | Clears report cookie on logout | [authSlice.js](../../client/src/store/slices/authSlice.js) and shell draft handling own the client side. |
| `GET, HEAD /api/session`; `POST /api/session/refresh` | Checks the staff report session | Sidi bypasses the old hosted Supabase login/request-code flow. |
| `GET, HEAD /api/reporting/view`; `/driver-audit-view` | Report HTML | `staffFrame=1` selects the same-origin embedded presentation. |
| `GET, HEAD /api/reporting/light/dates`, `/deliveries` | Saved dates and a page of deliveries | The chosen generation binds the date, driver and page offset. Publication changes restart pagination from a refreshed date list. |
| `GET, HEAD /api/reporting/light/case`, `/detail`, `/gps`, `/photo`, `/history` | Selected case and exact retained evidence | The archived case key and generation scope each read. Full details, GPS observations and photo bytes are verified against original immutable references. |
| `GET, HEAD /api/reporting/light/source-cases`, `/source-history` | Additional saved cases by day | The original assessments remain reachable by date. Cases that have history without a published delivery row do not contribute to delivery totals. |
| `GET, HEAD /api/reporting/light/reviews`; `POST /api/reporting/light/reviews` | Case-scoped review history and saves | POST checks the exact snapshot, issue, reviewer role and CSRF token. |
| `GET, HEAD /api/reporting/light/review-history` | Complete saved review history | The staff reader returns the original journal events, including older entries with an unavailable source snapshot. The route uses staff authentication and the existing journal size limit. It reads the journal without loading a report date or case. |
| `GET, HEAD /api/reporting/light/photo-suggestion` | The selected delivery's saved automated suggestion | Staff-only, generation-bound, and read-only. The reader reuses the saved suggestion and exact photo binding. It never starts grading, loads the entire old queue, or rewrites a review. |
| `GET, HEAD /api/reporting/status` | Report/source identities, CSRF token and bounded sync health | The legacy `storage: hosted` display field does not identify the selected data backend. |
| `GET, HEAD /health` on `127.0.0.1:5002` only | Private report-process readiness | Returns 503 until the verified serving package loads, then its generation, report hash, source revision and reviewed release. Never expose this listener or route through the public business API health endpoint. |
| `GET, HEAD /api/reporting/reviews`; `POST /api/reporting/reviews` | Reads or appends saved findings | POST needs reviewer/CSRF, exact snapshot/issue, expected revision, event ID and verified actor. Retry/conflict semantics preserve history. |
| `GET, HEAD /api/reporting/history-archive` | Looks up additional saved source assessments by delivery day and case | Uses the staff session and the selected report’s verified source and staff history references. Fetches case bytes on demand from the existing archive and leaves the published results and journals unchanged. |
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

The saved source assessments view reuses the archive catalog pinned by the selected release. The first date lookup streams the original browser snapshot to verify its hash and extracts only its history index. The runtime reuses the verified index for later lookups. Compare case versions against the preserved staff history using exact saved rows. The link appears in the staff report frame when its package declares a source snapshot.

## Source reporting change feed

The owned reporting worker can catch up through the operational app’s API. Keep this feed disabled until the source owner approves activation and verifies that the storage deployment supports MongoDB transactions.

- Set `MATTER_REPORTING_API_CLIENTS` to the existing report worker key labels. A bare key uses the `default` label. Normal external clients retain their existing delivery detail shape.
- Set `MATTER_REPORTING_CAPTURE_ENABLED=1` to record metadata-only events with the delivery write or completed GPS batch. The source uses a global committed sequence. The existing 10:30 and noon Dubai report builds remain separate.
- Set `MATTER_REPORTING_EMITTER_ENABLED=1` only with the approved HTTPS `MATTER_REPORTING_WEBHOOK_URL` and private `MATTER_REPORTING_WEBHOOK_SECRET`. The sender signs the Unix-seconds timestamp, a period and the exact JSON body. It retries the same event ID when delivery is uncertain. Disabling emission retains the recorded outbox.
- `GET /api/external/reporting/changes?after=0&limit=200` gives the upper sequence `through` for the page set. Retain that value and pass the latest `cursor` as `after` until `hasMore` is false. `GET /api/external/reporting/gps-batches/:id` returns only an immutable completed batch. The worker reads the changed delivery through `GET /api/external/deliveries/:id` and uses the returned `reportingVersion` to check the requested revision.
- `GET /api/external/reporting/days/:day/ids` reads Dubai scheduled-day IDs, status, update clock and reporting revision with the feed watermark in one read-only transaction. It fails above 5,000 deliveries rather than omitting rows. Compare IDs and update clocks against the reporting state to recover gaps from bulk paths outside the outbox. `GET /api/external/reporting/readiness` checks the connected database topology without attempting writes or exposing host details; it does not confirm data-write permission.
- Before enabling production, verify that a rolled-back delivery leaves no event, two concurrent saves produce consecutive cursors, an expired sender lease retries the same ID, and an unfinished GPS batch cannot be read. Verify one authorized saved proof and one completed GPS batch in the reporting Preview without writing a staff review.

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
| Existing Supabase reporting state, receipts and private archive | Selected canonical authority. Preserve exact results, collector/GPS/photo evidence, paid grading/uncertain attempts and all review namespaces. Sidi's execution marker does not import, reset or replace this data. |
| Supabase Sidi progress and HTTP admission | Additive private `matter_reporting_app` schema: typed delivery/GPS/validation progress, short retry rows, immutable original-photo references and bounded HTTP counters. Seven service-only RPCs expose these controls; original reporting tables, receipts and functions retain their identities. See [the migration](../../server/migrations/20261117103823_driver_audit_app_poll_progress.sql). |
| `driverAuditNativeDocuments`, `driverAuditNativeReceipts` | Exact heads and protected original receipt/event/revision/request clocks. Includes collector state, grades and every review/household namespace. |
| `driverAuditNativeHistorical` | Original delivery, issue, retained-row, run and private-response rows. |
| `driverAuditNativeFiles`, `driverAuditNativeChunks`, `driverAuditNativeControl` | Immutable file references, compressed transactional state/history, logical quota, exact object-store binding and verified authority. Legacy archive chunks stay readable during a guarded move. |
| Existing Sidi Spaces bucket | Selected path reuses original photo uploads only after exact bytes, size, object identity and retention are verified. Supabase stores a small immutable reference. Existing Supabase photos stay readable; other new immutable report/archive files remain in the existing private Supabase archive. The `driver-reports/archive/v1/` prefix belongs to the parked native archive option. Never delete report-referenced originals as cache cleanup. |
| `driverAuditNativeReviewContexts`, `driverAuditNativeReviewFiles` | Original review-linked snapshot/photo dependencies with provenance and original missing outcomes. |
| `driverAuditNativeLeases` | Collector and qualification writer ownership/fences; does not fence human review saves. |
| `driverAuditNativeArchiveControl`, `driverAuditNativeArchiveLedger`, `driverAuditNativeReservations`, `driverAuditNativeConsumption` | Archive allowance/reservation/operation identities. Only verified released reservation/operation records receive the documented limited expiry. |
| `driverAuditNativeTechnicalRecords`, `driverAuditNativeTechnicalChunks` | Bounded recent technical retry recovery. Its reclamation does not prune photos, GPS, grades or human/source history. |
| `driverAuditNativeRoadCache` | Disposable road geometry with its existing expiry; separate from raw GPS evidence. |
| `driverAuditObjects`, `driverAuditControl`, `driverAuditReleases` | Legacy MongoDB direct serving replica and roots. Keep its existing records as recovery evidence; the selected Supabase serving path must not depend on this connection. |
| Private source release root | `server/.private/driver-audit-source/MANIFEST/`: pinned runtime/environment, proofs, scheduler queue/cursor and status. |
| Private managed sync root | `server/.private/driver-audits/MANIFEST/`: `sync.json`, builder, baseline, validation journals, current/previous workspaces and recovery receipts. |

`collector-state`, `worker-config`, grading/recovery checkpoints and every original review/household journal retain their own provenance. The Sidi review namespace is `preview-gps-map-20261106:`. Namespace names do not make human history disposable; preserve other original namespaces too.

The selected report HTTP, source and sync processes share the managed hash-verified disk cache. Only collector-state has a revision pointer; each use still calls the original conditional-read RPC. Immutable archive cache hits cause no remote transfer. Original photos, evidence and reviews are authoritative in their original stores, not in these disposable copies. Keep independently verified backup metadata **and object bytes** outside caches and serving retention. In parked native mode, missing/corrupt native originals fail visibly without a Supabase fallback.

[driverAuditHeavyWork.js](../../server/services/driverAuditHeavyWork.js) uses `server/.private/driver-audit-heavy-work` to serialize heavy source children and full sync ticks. Source and sync also have separate OS-backed worker locks; source controls have a deployment lock. Preserve their acquisition/drain paths. A stopped supervisor or a remote collector lease alone does not prove that every in-flight review, source child or serving-root update has finished.

## Configuration owners

Keep values private. Check names and effective settings at each process boundary:

| Owner | Settings |
| --- | --- |
| Existing server | `MONGODB_URI`, `JWT_SECRET`; [loadEnv.js](../../server/loadEnv.js) loads `.env` first and `.env.local` overrides before other app imports. |
| Serving/direct sync | `DRIVER_AUDIT_ENABLED`, `DRIVER_AUDIT_IMPORT_ENABLED`, `DRIVER_AUDIT_ORIGIN`, `DRIVER_AUDIT_CAPACITY_BYTES`, `DRIVER_AUDIT_REPLICA_GC_ENABLED`. Direct sync keeps the old publication importer disabled; serving capacity is separately bounded. |
| Native selection | `DRIVER_AUDIT_DATA_STORE`, `DRIVER_AUDIT_NATIVE_CAPACITY_BYTES`. App/sync/source must agree on the selected store; the app owns URI and native quota. |
| Sidi execution with Supabase | `DRIVER_AUDIT_EXECUTION_HOST=sidi`; app/sync/source and the pinned manifest/backend capabilities must agree. Keep `DRIVER_AUDIT_DATA_STORE` unset or `supabase`. Source uses its staged credential and exact managed archive-cache path. |
| In-app Supabase reader | The reviewed release selects `DRIVER_AUDIT_SERVING_STORE=supabase` and `DRIVER_AUDIT_LIGHT_READER=1` with `DRIVER_AUDIT_IMPORT_ENABLED=0`. The existing private archive and cache carry the verified `app-sidi-report-head` and its `lightView` reference. The worker uses its own qualification and configuration. |
| Separate report HTTP | Explicit `DRIVER_AUDIT_DATA_STORE=supabase`, `DRIVER_AUDIT_ENABLED=1`, `DRIVER_AUDIT_IMPORT_ENABLED=0`, reviewed `DRIVER_AUDIT_RELEASE_SHA`, renderer/cache settings, existing staff `JWT_SECRET` and Supabase/Spaces credentials. Its private environment excludes the operational MongoDB URI. It uses the existing staff API for account/permission checks. |
| Native archive location | `DRIVER_AUDIT_NATIVE_OBJECT_STORE=spaces`, `DRIVER_AUDIT_NATIVE_PHOTO_CANDIDATES_SHA256`, and existing app `SPACES_*`. The candidate file is owner-private under `server/.private/driver-audit-native-photo-candidates/`. This setting can be prepared while live authority is still Supabase; it does not restart the app or start report workers. |
| Legacy transport compatibility | `DRIVER_AUDIT_SUPABASE_SECRET`, `MATTER_SUPABASE_SECRET`. Native code uses injected native transports; keep the recovered source's declared input contract until a qualified change removes an input. |
| Private source environment | `CRON_SECRET`, `MATTER_DELIVERY_API_KEY`, `MATTER_DELIVERY_ENABLED`, `MATTER_PHOTO_READ_ENABLED`, `MATTER_PHOTO_GRADE_ENABLED`, `MATTER_GPS_ENABLED`, `MATTER_GPS_PUBLICATION_ENABLED`. Preserve disabled switches/scope; its native declaration excludes app URI/quota. |
| Grading and source cache | `AI_GATEWAY_API_KEY`, `MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY`. The supervisor supplies the qualified grading identity through the original handler header. Persisted OIDC tokens are rejected. Cache path must match the managed builder. |
| Renderer/map display | `DRIVER_AUDIT_STAFF_RENDERER_DIR`, `DRIVER_AUDIT_STAFF_RENDERER_SHA256`, optional `MATTER_PREVIEW_ROADS_KEY`; captured map configuration and renderer bytes have separate private provenance. |
| GPS producer | `VEHICLE_LOCATION_RECORD_INTERVAL_MS` and existing Truckoom configuration; polling cadence does not establish GPS-fix cadence. |
| Operator controls | Exact `DRIVER_AUDIT_DEPLOY_*`, `DRIVER_AUDIT_SOURCE_*`, builder identities and staff/restore/release proof references. Workflow secret envelopes and private profiles are not browser configuration. |

The report HTTP process caches its integration context and sync opens its backend at process start. A shell export alone does not switch running processes. Verify persisted Supabase/Sidi settings, exact release and actual current/previous serving packages. Native authority checks apply only to the deliberately selected parked mode. An accepted workflow request or report presentation label is not evidence of a completed switch.

## Safe operating entry points and recovery

Use the exact deployed app SHA and reviewed inputs. The workflows share `production-deploy` serialization:

- The [in-app reader and separate worker guide](source-worker.md#in-app-reader-and-separate-worker) covers the current rollout. Preserve the owner-requested Actions pause.
- The on-server Supabase operations in the [handoff workflow](../../.github/workflows/driver-audit-native-handoff.yml) can stage the isolated on-server release, retain current and previous serving reports, start the private report HTTP service and qualify held source and sync. The [control operator](../../.github/scripts/driver-audit-supabase-control.mjs) applies the [on-server operation boundaries](source-worker.md#sidi-execution-with-the-existing-supabase-store).
- The same workflow's [canary controller](../../.github/scripts/driver-audit-supabase-canary-control.mjs) handles read-only privilege probing, private staff preview and separately guarded report-only routing promotion; its [fixed configuration helper](../../.github/scripts/driver-audit-supabase-canary.mjs) preserves other routes. The [source-release controller](../../.github/scripts/driver-audit-supabase-release-control.mjs) exports fixed encrypted evidence, stages the actual final Supabase proof pack, and invokes the real source/start/sync controls after verification. Read [the boundaries](source-worker.md#sidi-execution-with-the-existing-supabase-store); none of these operations is an automatic deployment or a data-store migration.

- [Native handoff bridge](../../.github/workflows/driver-audit-native-handoff.yml): inspect the actual target/census, stage and verify private data/code/proofs, hold or qualify the managed workers, and perform the separately guarded `activate-native` and `start-native` transitions. Main's operations revision can differ from the explicit deployed app SHA. Read the [operation boundaries](private-source-maintenance.md#operations-and-their-boundaries) before selecting an operation; staging and preparation leave authority inactive.
- [Deploy/source controls](../../.github/workflows/deploy-digitalocean.yml): existing explicit source stage/check/qualify/start/pause/resume/rollback and builder/serving release operations. Its source-operation guards require the reviewed main/deployed commit to agree. Follow [source cutover evidence](source-worker.md#cutover-evidence).
- [Sync diagnostics](../../.github/workflows/audit-sync-status.yml): use only the explicit reviewed diagnostic/maintenance choice; some choices mutate derived workspace state. Read the helper and its accepted operation before dispatching.
- [Native migration CLI](../../server/scripts/driverAuditMongoMigrate.js): `plan`, `stage`, `verify` with an absolute owner-private profile and its SHA-256. [Receipt selection](../../server/scripts/driverAuditSelectReceipts.js) preserves backup-only bookkeeping separately. CLI inventory verification leaves complete archive closure and activation pending.

For the current Supabase path, qualify the off-host release and verify shared review writes and the report reader across the old-writer admission change. Preserve a fresh backup and compare current and previous report packages before selecting the new reader. Reserve the [final native authority handoff](source-worker.md#final-authority-handoff) for a separately authorized MongoDB rollout. Use the established owner-private transfer and proof paths for production data.

Source rollback stops/drains its process and marks the source receipt; it does not reconcile native edits into Supabase. Full `audit-rollback` disables report access and removes sync registration; it is not a pause or a reverse native migration. After native semantic writes, retain native authority and newest journals until all new reviews, grades and collector changes are reconciled into any proposed prior authority. Preserve original encrypted backups and required historical links. See [builder rollback](builder-transition.md) for restoring builder code while retaining a newer verified report.

## Verify live data flow

Keep a private acceptance receipt that binds the deployed app/report HTTP process, source/config/environment, Node, builder/renderer, selected store/host and serving-pointer identities. Distinguish implementation fixtures, Linux host qualification and these actual production observations:

1. Verify the in-app report settings, the `app-sidi-report-head` serving pointer and the actual off-host source and sync registrations. Verify the old publication paths are held and shared human reviews remain writable. Record the source heartbeat and its exact configuration independently of the first successful collection.
2. Trace an actual completed delivery capture through its source observation clock, reconciled pages/counts, immutable response hashes and saved source revision. Preserve provider time, upload time, GPS-fix time, capture time, build/publication time and staff-visible cutoff separately.
3. Observe **changed evidence** advance the source basis and produce a validated direct report publication with a matching current serving pointer. Open the report in the Sidi staff app and reload it. An unchanged poll correctly keeps the original capture, generation and evidence clocks; its bounded technical progress records when checking succeeded. That alone does not prove a new report was built.
4. Open the changed delivery's original photo and dated GPS evidence through the staff APIs. Check image hash/record/proof binding, GPS source/window/assignment identity and original missing outcomes. Verify originals from the selected backend rather than relying only on warm cache bytes. Neither a vehicle position nor a destination pin proves handover.
5. Observe an eligible new image reach a completed grade with matching image/binding, durable result receipt and budget settlement, then appear in the published report. Accepted, uncertain, deferred or failed provider work remains pending; do not blindly repeat uncertain inference.
6. Confirm original review/household history survives publication and reload. Prove new save, lost-acknowledgement retry, stale conflict and restart in isolation. Production exact-event retry requires the original verified actor and exact request; a genuine authorized staff response can prove a new production save. Never append a fabricated finding to a real customer's immutable history.
7. Verify overnight operational GPS capture independently of the 10:30 am and noon Dubai report schedule. For an unchanged noon check, compare the served generation, archive writes and publication receipts before and after. For changed evidence, verify only one validated update at that check and trace the relevant late delivery, GPS or photo through the report. Verify pause/restart retains pending evidence and the last verified report. Keep backups and all newest authoritative edits throughout recovery.

For an Activity history release, also check that a real authorized report request retains the original staff account identity while its canonical saved-review actor/history and permissions remain unchanged. This live identity check is pending; local auth, integration and offline fixtures do not establish production acceptance.

Record each result and unresolved gap. A report displaying only its pre-activation capture, a source-only success, or a passing fixture suite does not complete this journey.

## Operational tracker activity volume (2026-11-21)

The generic Mongoose activity producer is
[`activityDatabase.js`](../../server/observability/activityDatabase.js), with
the narrow predicate in [`activityScope.js`](../../server/observability/activityScope.js).
The operational `customer-tracker-visits` job writes Delivery `trackerVisit`
and occasionally its one-time `trackerVisitGpsBaseline`. Its full pre-write
snapshot duplicated the terminal audit payload in `activity_audit_events`.

The prepared change defers only that automated tracker-only `updateOne` start
snapshot. It retains saved/unchanged terminal events and records a failed write
as explicitly uncertain without exposing raw errors. Human/action contexts,
mixed business fields, upserts, bulk writes and other jobs retain their existing
audit behavior. A crash before any terminal outcome no longer has an individual
durable tracker-start row; job telemetry and the independent tracker/GPS retry
and evidence paths remain. This is not a blanket Delivery audit exclusion.

Impact check: GPS acquisition, immutable capture batches, tracker history,
delivery proof/status, original report evidence, Supabase reviews, source and
builder controls are unchanged. No private source export or serving package
needs replacement for this generic operational activity change.

Local acceptance: `activityTrackerVisit.test.js` covers exact predicate
boundaries, saved/unchanged/uncertain outcomes, original error propagation and
real Mongoose writes in disposable MongoDB. Run the existing activity scope,
transaction, journal, vehicle capture/store and Truckoom visit tests too.
The optional integration uses `TRACKER_AUDIT_TEST_MONGO_URI` and refuses
non-loopback/non-test databases; it drops only its synthetic database.

Production acceptance remains pending: verify actual serving SHA and sample
tracker write outcomes plus continuing operational GPS capture after a separately
authorized release. This note authorizes no deployment, deletion or retention
change. Existing started/saved rows remain intact. A possible redundant start
is `stage=record_change_started`, `outcome=pending`, not a `status=started`
field. Its confirmed saved counterpart must independently match `operationId`,
`job=customer-tracker-visits`, `record.type=Delivery`, the same `record.id`,
`stage=record_saved`, `outcome=saved`, and a non-earlier event time. Event IDs
are different: the start uses its own UUID, while the saved event uses the
operation UUID. Unmatched, failed or uncertain attempts are outside any
redundant-start cleanup. Backup, restore proof and cleanup admission are a
separate prerequisite owned by the incident coordinator.

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
| Date-indexed reader, original assessment policy and saved reviews | `driverAuditLightReader.test.js`, `driverAuditLightProjection.test.js`, `driverAuditLightPolicy.test.js`, `driverAuditLightReviews.test.js`. |
| Scheduled delivery selection and original evidence | `driverAuditDeliveryChanges.test.js`, `driverAuditDeliveryCaseProjection.test.js`, `driverAuditDeliveryView.test.js`, `driverAuditSupabaseReplica.test.js`, `driverAuditOffHostWorker.test.js`. Check one new delivery, a noon update at the same collector revision, and a later unchanged check. The untouched archive and evidence hashes must match. |
| Source schedule/stage/process/host binding | `driverAuditSource.test.js`, `driverAuditSourceStage.test.js`, `driverAuditSourceDeployment.test.js`, `driverAuditSourceQualification.test.js`, `driverAuditHeavyWork.test.js`. |
| Hosted qualification, duplicate-slot admission and recovery | `driverAuditHostedBootstrap.test.js` under `server/scripts/`, `driverAuditHostedSlots.test.js`, `driverAuditHostedCache.test.js`, `driverAuditPhotoRecovery.test.js`. |
| Selected Supabase backend, serving, sync and photo reuse | `driverAuditSupabaseAppBackend.test.js`, `driverAuditSupabaseArchive.test.js`, `driverAuditSupabaseTransfer.test.js`, `driverAuditSupabaseReplica.test.js`, `driverAuditSupabaseSync.test.js`, `driverAuditHttp.test.js`, `driverAuditSpacesArchive.test.js`. |
| Selected Supabase bounded metadata and shared caches | `driverAuditSupabaseAppProgress.test.js`, `driverAuditPollProgress.test.js`, `driverAuditReadCache.test.js`, `driverAuditCollectorReadCache.test.js`, `driverAuditFixedHostBudget.test.js`. The SQL fixture requires `DRIVER_AUDIT_TEST_PG_BIN` pointing to a verified PostgreSQL 17 bin directory. |
| Parked native import/RPC/archive/history | `driverAuditLiveImport.test.js`, `driverAuditSelectReceipts.test.js`, `driverAuditMongoImport.test.js`, `driverAuditMongoRpc.test.js`, `driverAuditMongoArchive.test.js`, `driverAuditMongoText.test.js`, `driverAuditReviewContexts.test.js`. |
| Parked hybrid files and native polling | `driverAuditMongoArchive.hybrid.test.js`, `driverAuditNativeObjectStore.test.js`, `driverAuditPollProgress.mongo.test.js`; native object-store and cleanup operator tests under `.github/scripts/`. Use an isolated local Mongo replica only when working on that separate mode. |
| Parked native backup transfer | `driverAuditTransferCodec.test.js`, `driverAuditTransferSession.test.js`. |
| Direct sync/build/retention/recovery | `driverAuditSync.test.js`, `driverAuditDirectImport.test.js`, `driverAuditDeployment.test.js`, `driverAuditBuilderTransition.test.js`, `driverAuditBuildRecipe.test.js`, `driverAuditGarbageCollection.test.js`, `driverAuditWorkspace.test.js`, `driverAuditWorkspaceRetirement.test.js`. |

Parked Mongo database tests need an isolated transaction-capable `MONGO_TEST_URI`; they are not a prerequisite for running the selected Supabase service. Skipped database cases are not database verification. Source supervisor fixture tests use synthetic handler modules, so they do not replace exact private-source replay, credential qualification or Linux memory/disk acceptance. Upstream GPS changes also need the capture/store and `server/routes/externalDriverLocationApi.test.js` checks described in [GPS database review](../GPS_DATABASE_REVIEW.md).

For import-control changes, run `node --test .github/scripts/driver-audit-native-import.test.mjs` from the repository root. Its fixtures cover the encrypted session, private input pins, actual target/worker/root guards, plan/stage/verify dispatch and failure cleanup. They do not import production data or establish production parity.

For complete native parity changes, also run `node --test .github/scripts/driver-audit-native-parity.test.mjs`. Its fictional native-store fixtures reject changed result/history/event/clock bytes, corrupt GPS/photos, missing provenance, context availability changes, provisional closure, target identity changes and collector drift. Host-boundary fixtures verify owner-private receipts and cleanup without database writes. Full-byte attestation reuse always keeps current record/review/census checks fresh; it is explicitly distinguished from a fresh full byte scan. Production acceptance still requires the actual final source proof and writer fences.

For staff shell changes, run these commands from `client/`:

```sh
CI=true npm test -- --watch=false --runInBand \
  --runTestsByPath src/pages/DriverReports.test.js
npm run build
```

Finally verify the affected browser and live journey, including reload, failure and recovery. For documentation-only edits, check referenced files/anchors, route/config names and public/private boundaries; no application fixtures or production operations are needed.
