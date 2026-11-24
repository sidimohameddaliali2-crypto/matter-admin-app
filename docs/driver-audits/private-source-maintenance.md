# Maintaining the report generator and builder

The public repository contains the application, backend adapters and reviewed deployment controls. The complete scheduled generator and builder are private code exports because they contain business identity configuration. They must be recoverable from Sidi's own server and independently retained private code/data backups; a previous developer's checkout is not a maintenance dependency.

The selected handoff keeps the existing Supabase authority and runs generation on Sidi. It remains pending actual Linux qualification and live acceptance. See [Sidi execution with Supabase](source-worker.md#sidi-execution-with-the-existing-supabase-store). Do not require a native MongoDB import, change storage selection or run the native mutation fence to perform that handoff. The native code-archive lookups below describe the parked native path; verify the actual location and readback receipt for the selected Supabase release separately.

For the parked native/hybrid option, MongoDB holds records, reviews and file references; complete immutable code archives and evidence bytes may live in Sidi's configured Spaces bucket. Follow a reference through its actual selected archive adapter and verify its hash. An archive reference, photo URL or candidate lookup alone is not an independent byte backup. Keep original encrypted backups and their verified restore evidence.

Migration acceptance is separate from this code map. Check the effective store/host settings, workers, stage receipts and complete code archive or backup readback before reporting a completed handoff. Standalone source staging saves the full code locally but does not by itself prove an independent archive backup of a new release.

## Find the actual implementation

| Component | Server location or lookup | How to identify its exact bytes |
| --- | --- | --- |
| Scheduled generator | `server/.private/driver-audit-source/<manifest>/source.json`, then its `runtimeRoot` | `manifest.private.json` lists every source file; `source.json` separately pins environment, Node and cache. The runtime has all declared schedules, not only the visible report handler. |
| Complete generator code archive | `stage.private.json.bundleSha256` in that same release directory | Native archive object `<bundleSha256>.gz`. The native handoff's `stage-source` operation writes and reads back this complete code envelope; the standalone source staging script stages local files only. The separate secret environment is not archived in the code bundle. |
| Actual builder | Managed sync PM2 registration → `sync.json` → `codeRoot` | `runtime-manifest.json` and `sync.json.builderSha256`. Read the live version; an earlier local export can lack fixes. |
| Complete original/replacement builder archives | Matching reviewed `NATIVE_BUILDER_CODE_ARCHIVES` in [the import operator](../../.github/scripts/driver-audit-native-import.mjs), plus the stage result | Private native `<SHA>.gz` code envelopes. Staging verifies the full manifest and every code file in both envelopes before allowing the candidate. A one-file delta is insufficient for independent recovery. |
| Renderer and validation journals | `sync.json.rendererBuild` and `sync.json.journals` | Separate exact hashes; these are distinct from builder code and may contain private captured material. |
| Serving adapter and staff routes | `server/vendor/driver-audits` and `server/services/driverAuditIntegration.js` | Tracked Git revision and vendor manifest. See the [maintenance map](maintenance-map.md) for every staff/source route and store. |

Read native code objects through [driverAuditMongoArchive.js](../../server/services/driverAuditMongoArchive.js), using the existing app database and explicit configured capacity. Keep retrieved bytes in an owner-private directory; verify the compressed SHA, envelope manifest and every decoded file before using them. Restore only declared safe paths, preserving their exact bytes. Never print credentials or publish a decoded private bundle.

The read-only `inspect-bindings` operation with `diagnostic_page=builder-all` can export the complete stopped live builder to an operator's temporary RSA recipient. It verifies the actual manifest/files before and after and sends only encrypted pages. Reassemble and verify every page, the gzip SHA, raw envelope SHA, manifest and all files. Hashes and counts in an Actions log alone are not the recovered code.

## Make a maintained change

1. Read the actual application commit, selected store/execution host, PM2 registrations and effective configuration; inspect native authority only for native mode. Retain current receipts, private packages, source cutoffs and original missing-evidence outcomes. Do not infer activation from documentation or a successful staging job.
2. Recover the complete current code and its independent inputs using the lookups above. Create a separate private candidate. Compare against the live manifest so existing fixes survive. Keep public application changes in the normal reviewed Git branch; keep private source files and credentials outside Git.
3. Change only the relevant source or builder files. Recompute the complete manifest, code envelope and delta where applicable. Preserve source schedules, paid grading limits and uncertain attempts, review identifiers, original clocks, customer pins and all existing authoritative writes.
4. Test the changed behavior and legacy compatibility. Cache changes must prove identical original bytes and results, missing/corrupt/abort behavior, bounded shared writes and no hidden second cache. A complete private source package must satisfy its original environment and runtime contract.
5. Stage code through the reviewed controls. The migration-only native handoff operations require stopped workers and inactive authority. After native activation, use the existing source/builder deployment controls with their current admission requirements and separately retain and read back the complete code archive in native storage. Never disable authority or discard new edits merely to reuse a migration operation.
6. Qualify the exact Linux application, source, environment, Node, builder, renderer, journals and cache. The controlled rehearsal starts a real sync process behind the shared heavy-work lock, measures its actual PID/RSS, runs isolated source → builder → source, then durably pauses it before releasing exclusion. Catchable interruption and cleanup checks are distinct from protection against a forced process kill.
7. Publish only after current preservation, release and acceptance gates pass. Keep original code/configuration and content-addressed receipts for recovery. An older code rollback must retain or reconcile the latest native records and reviews; restoring an old database snapshot is not a routine code rollback.

## Operations and their boundaries

The [native handoff workflow](../../.github/workflows/driver-audit-native-handoff.yml) pins the actual deployed application SHA independently of an operations-only main commit. It sends only the selected reviewed operator, keeping SSH input bounded. Public inputs are hashes, UUIDs and an optional RSA public recipient; customer data and secret environments travel through authenticated encrypted staging.

| Operation | Effect |
| --- | --- |
| `prepare-transfer`, `receive-transfer` | Reuse verified backup bytes; authenticated immutable writes and private inputs. Downloads use bounded, fully drained ranges with exact length, 206 response and ETag/version checks. A dropped connection retries its bounded range; a process restart uses the same encrypted session and immutable object checks. Original backups remain intact. It does not activate authority. |
| `inspect-database-config` | Compare fresh, read-only probes of effective, durable and available PM2 launch configuration. Outputs contain no connection strings or credentials. A saved launch snapshot is not proof of the running driver's connection. No environment value or data is changed. |
| `plan-native-cleanup`, `apply-native-cleanup` | Plan then remove an exact backup-pinned unused migration batch and only its unreferenced chunks. Require absent native authority, no native records/reviews/unknown references, held workers and unchanged serving roots. Original backups and sessions stay intact; this is never a general database cleanup. |
| `prepare-object-store`, `externalize-native-archive` | Prepare only the hybrid archive location and pinned photo lookup, keeping live authority and workers unchanged. Review a separate target plan before bounded moves of unused staging to verified Spaces objects/aliases; commit metadata/chunk/quota changes together and retain the bounded recovery journal. Do not run this staging-only path after native records or reviews exist. |
| `stage-source`, `stage-builder` | Prepare complete hash-checked private code. Preserve the active implementation and leave workers held. |
| `stage-lineage` | Retain an exact original source receipt for an explicitly missing historical temporary working copy; see [the gap policy](historical-source-lineage.md). |
| `create-profile`, `plan-import`, `stage-import`, `verify-import` | Derive real host paths/census, plan and stage exact data, then verify actual source/native records and report queries. A stage receipt is not complete parity. |
| `disable-pruning`, `prepare-native-settings` | Preserve exact before bytes; disable disposable replica pruning or prepare the three native backend settings. Preparation does not select the native backend. |
| `swap-builder-held` | Exact guarded builder transition; keep the worker stopped, retain the old code/config, and require a new profile for the changed census. |
| `qualify-source` | Run the real held Linux rehearsal with the separately pinned saved fixture; a partial result remains unqualified. |

Full-byte archive attestations bind the complete physical reference metadata, object-store identity and the reviewed Mongo archive, Spaces adapter and factory code. A move, alias ETag/version change or reader implementation change invalidates cached proof. Qualify again using the actual destination; do not reuse the earlier Mongo-only byte pass.

Before dispatching, check actual workflow states. An owner may pause all repository Actions, including automatic deployment and CI. Preserve that pause while preparing changes locally; enable only a reviewed, needed manual operation and disable it again. Merging code while deployment is paused does not establish that the server runs that code.
| `stage-native-proofs` | Copy only fixed immutable proof JSON aliases from another verified transfer. Preserve the original import session and bind supplemental provenance. It does not certify proof semantics. |
| `export-native-controls` | Send fixed current private controls and qualification receipts to an explicit RSA recipient for local release assembly. Verify their exact bytes and current identities; the export grants no authority or qualification. |
| `verify-native-parity` | Complete read-only preservation verification. Reuse a full byte attestation only when the exact inventory, target, references/chunks and reader implementations still match. |
| `activate-native`, `start-native` | Separate guarded authority/settings/API transition and worker admission. Require final backup, exact parity, legacy capability fence and actual host qualification; preserve recovery receipts and later native edits. |

Use the [source-worker guide](source-worker.md), [builder transition guide](builder-transition.md) and [complete parity contract](native-parity.md) for their exact inputs. Update this map when adding a route, input, store or control, and distinguish fixtures, actual Linux qualification and live staff/source acceptance in release documentation.
