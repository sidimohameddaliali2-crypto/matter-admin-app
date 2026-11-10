# GPS reliability: purpose, review and rollout

This is the entry point for reviewing the GPS reliability change. The code is a PR candidate until its exact revision is accepted and deployed. The existing report layout is unchanged.

## What the change fixes

A one-minute collection schedule means the application asks for the latest available position approximately every minute. It does not mean the tracker measured a new position every minute. The provider can return the same older fix repeatedly. A stopped vehicle, a stale fix and a missed collection are different conditions; none should be inferred from an empty report alone.

| Problem | Change | Remaining limit |
|---|---|---|
| Collection time can be mistaken for position time | Keep the tracker clock, provider server clock, response receipt and collection clock separately. | Missing clocks remain unknown. |
| Normalization can discard evidence | Retain scoped source JSON with a hash, including unusable rows; preserve quality markers through comparison. | This is not the original HTTP byte stream or a complete provider-fleet archive. |
| An interrupted save can leave partial history | Save an immutable capture batch first; retry the same row identities after restart. | A process that never starts a tick cannot record its absence. Unreceived responses cannot be recreated. |
| Repeated or conflicting readings can imply false certainty | Screen gaps, missing clocks, future timestamps, conflicting positions, impossible jumps and ambiguous assignments. | GPS supports observed vehicle presence, not physical handover or historical driver identity. |
| A revised calculation can hide an earlier result | Preserve the previous legacy GPS assessment once before replacing it. | This is one baseline, not a journal of every subsequent assessment. |
| Reports cannot distinguish unavailable evidence | Export bounded quality/provenance metadata and separate capture status. | A successful export alone does not prove complete coverage. |

Source changes are in this application repository. The downstream reporting importer and its acceptance checks are a separate release. Changing the source does not automatically repair previously published reports or recover unrecorded GPS fixes.

## Where to review

- [Repository impact map](GPS_CHANGE_IMPACT.md): modules inventoried, dependent paths and regression boundaries.
- [Database review](GPS_DATABASE_REVIEW.md): collections, indexes, recovery and deployment checks.
- [GPS interpretation](GPS_EVIDENCE_METHOD.md): exact evidence rules, statuses and limitations.
- [External API](EXTERNAL_DELIVERY_API.md): saved-history fields, pagination and capture-status contract.

The live view remains usable when only source archiving fails. Such a response is ineligible for a successful evidence capture. A provider request failure retains the existing operational fallback behavior. The database and archive add work to the shared live path; latency, capacity and failure behavior still require qualification.

## Acceptance before merge

Merging to `main` automatically deploys this repository. Complete these checks against the final PR revision before approving that production action:

1. Review the current base and the changed paths, including both driver-assignment write paths, live-map callers, historical cache, delivery proof reset and external APIs. Confirm there are no unrelated changes.
2. Run explicit fixture tests and the client production build. Separate new failures from failures reproduced on the unchanged base. Do not start the application or run ad-hoc vendor/database scripts as a test shortcut.
3. In an isolated database, exercise partial saves, uncertain write acknowledgements, two workers, lease expiry and restart. Read back identities and hashes. Fixture tests are not proof of real database recovery.
4. Read the actual deployment configuration and database index options. Confirm write concern, journaling, index creation permissions, storage growth, process count and backup/restore capability. Keep operational findings private.
5. Exercise authorized staging journeys: live map and phone fallback; conflicting assignments; valid and unusable history; photo submission, retry and offline sync; delivery edits; existing tracker-card rendering. Verify reload and saved evidence as well as the initial response.
6. Qualify the downstream importer against null locations/clocks, missing legacy metadata, duplicate observations, partial pages and later-arriving rows. Preserve every original export separately from the derived reporting view.
7. Record pass/fail evidence, unresolved risks, rollback instructions and the exact revision. Obtain the deployment owner's approval. Preserve any existing collector pause or provider budget until explicitly authorized to change it.

## After an approved deployment

1. Confirm the deployed revision and running processes. Check the new collections/indexes and capture outcomes without resetting data or restarting unrelated integrations.
2. Observe a full closed Dubai delivery day. Compare the enabled collection schedule with recorded tick outcomes; independently reconcile the expected vehicles. A day with no tick rows is unknown, not a healthy zero.
3. Reconcile four separate quantities: source response receipts, completed/failed/pending ticks, saved observations and distinct usable GPS fixes. These totals intentionally differ. Investigate gaps without filling them with invented timestamps.
4. Export all history pages for the same closed window, retain the response metadata, deduplicate imports by source row ID and repeat the export after pending captures settle. Require stable IDs and totals before accepting the report input. Offset pagination is not a frozen database snapshot.
5. Restore a bounded copy and verify receipt hashes, batch identities and report replay. A stored hash alone does not prove recoverability.
6. Connect the qualified source to the reporting pipeline. Keep the existing report format; use short explanations such as “GPS time unavailable”, “Last position repeated” or “Driver assignment unclear” where justified. Compare a saved report before and after, including totals and previously reviewed decisions.

If evidence is incomplete, retain it and label the affected conclusion as unavailable or requiring review. Do not classify missing GPS as a missed delivery, overwrite original observations, or silently replace an already published assessment.

## Recovery and rollback

Pending saved batches are retried automatically in bounded work per poll. Abandoned ticks without a saved payload become failed; the system does not fetch today's position and label it as an old observation. Capture status exposes recorded outcomes, not a guaranteed schedule or fleet inventory.

On repeated failures, inspect bounded failure codes and deployment health first. Keep evidence collections and pending batches intact. Any manual replay, retention policy, destructive cleanup or change to the collection schedule requires a separately reviewed procedure. Rolling code back must not delete appended evidence; verify older code's tolerance of additive fields and null positions before switching versions.

## Follow-up review status (2026-11-10)

Independent review found and fixed impossible-jump taint loss across uncertainty barriers and receipt decoding after native/lean Mongo readback. See the [follow-up qualification record](GPS_CHANGE_IMPACT.md#independent-follow-up-qualification--2026-11-10) and [isolated database evidence](GPS_DATABASE_REVIEW.md#isolated-recovery-evidence-2026-11-10). Local recovery and fixture evidence do not qualify actual deployment configuration, staging journeys or the separate reporting importer. **Keep this PR in draft; deployment is not ready until the remaining acceptance gates are satisfied.**
