# Historical source receipt retention

The collector census selects original source receipts needed by retained report roots. A missing temporary rendered working directory is a separate availability gap. It must never be represented as a recovered or verified rendered report.

[driverAuditLiveImport.js](../../server/services/driverAuditLiveImport.js) normally resolves every previous reference from the original bootstrap, accepted workspace, direct seed or retirement receipt. Unknown references still stop the census. An optional owner-private `historical-source-lineage.private.json` can retain an independently recovered original source receipt for a historical accepted report whose previous temporary directory and parent were already absent.

The proof binds the exact retained owner's accepted-file hash, complete previous tuple, original collector receipt (including body, event, request hash and original timestamp text), restored-backup provenance and original builder source-basis implementation. The collector revision must precede the owner. [driverAuditOriginalSourceLineage.js](../../server/services/driverAuditOriginalSourceLineage.js) derives the source basis from the original body and checks the full actual builder plus the unchanged basis module. During an interrupted managed builder rename it can use only the exact retained old builder when the canonical directory is absent; it does not fall back from a present but corrupt directory.

This exception cannot replace the current pointer, its previous report, either Mongo serving identity or either serving rendered manifest. It rejects changed owners, tuples, receipt fields, basis implementations, existing directories, duplicate or unused proofs and changes during the census. No accepted receipt, source state or serving pointer is rewritten. The census hash includes both the proof and an explicit `preexisting-missing-temporary-report-workspace` gap with `workspacePresent: false` and `renderedManifestAvailable: false`.

The returned `receiptBindings` must be passed into `createDriverAuditReceiptSelection`. Selecting that collector revision with a different original body, event or timestamp fails. The migration CLI and complete parity verifier preserve this binding; retaining the revision alone is insufficient.

The reviewed `stage-lineage` handoff operation receives only the exact encrypted, hash-pinned private proof. It writes that new immutable proof metadata and runs the actual census against unchanged original source reads. It does not create the missing working directory, activate native authority, start workers or update driver data. A failed census is not a successful handoff.

Keep the original source receipt and restored backup. Complete source closure must independently verify the original delivery results, GPS, photos and human review dependencies. A source-basis match does not prove the bytes of an unavailable rendered working copy. Carry that preexisting temporary-copy gap into the final preservation evidence instead of removing it from the record.

Validate with `node --test services/driverAuditLiveImport.test.js` from `server/`, the native import operator tests, the server suite and the actual paused-host census. Fixture checks alone do not establish production parity.
