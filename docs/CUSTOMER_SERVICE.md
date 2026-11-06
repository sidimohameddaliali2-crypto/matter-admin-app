# Customer service workspace

This feature adds an internal review and follow-up workspace at `/customer-service/chats`. It does not replace Gallabox as the messaging inbox. Saving, assigning or completing an internal action sends no customer message and changes no subscription or delivery.

## Delivered workflow

- Four pages with one connected header: Summary, Problems, Customers, Customer chats.
- Explicit reviewer/supervisor membership, linked to existing User IDs. A generic Admin role or page permission is not membership.
- Central review allocation based on declared planned minutes, with one active review and two pending per person. Equal capacity alternates assignments; unavailable, zero-capacity and self-review candidates are excluded.
- Reproducible agent-stratified baseline cohorts and separate targeted/calibration records. Sampling metadata and captured-population denominators are retained. These are not complete company-wide staff statistics.
- Transactional claim, draft, review+action save, duplicate-command recovery and audit history. Submitted revisions are retained when evidence changes. A review never counts as customer resolution by itself.
- Internal action owner, due time, original promised deadline, waiting reason/next check, evidence-based completion and explicit reassignment. Supervisors oversee unassigned/overdue work. Reviewer access is scoped to their assignments/actions.
- Read-only on-demand Matter subscription context via the existing backend integration. Missing/stale links and failed lookups stay explicit; viewing context does not silently repair source links.
- Dated normalized message import and four-visible-page XLSX export, with hidden review/action evidence. Dates use Dubai boundaries; source timestamps remain UTC ISO instants. Summary, lists and export use the same source population/filter logic.

## Initial staff setup

No named staff, real account IDs, customer records or grants are seeded. Existing permissions remain unchanged. Configure display labels and planned availability deliberately; an active login does not establish spare time.

An existing super_admin can open the workspace and select the initial supervisor. If the installation has no super_admin, an authorized operator can use `server/scripts/configureCustomerService.js` against the explicitly verified deployment/database: dry-run first, then `--apply` only under approved live-access change authority. This grants only service membership, not a new global account role. Do not create/reset an authentication account just to enable this module.

The supervisor can then select existing internal accounts, assign reviewer membership, set a Dubai availability date/planned minutes and map source sender identifiers. Supervisor promotion remains restricted to super_admin or the controlled operator setup. Drivers and portal-only roles cannot be enrolled by bypassing the candidate selector.

Source author mapping uses strings `source:scope:externalAuthorId`. A staff member may have a **disabled** service profile with sender mappings: identifying the original responder does not grant them review access. Conflicting mappings block capture. Reimport identical messages under a new request ID after resolving mappings to resolve previously unknown attribution; existing conflicting verified attribution is never silently overwritten.

## Capture contract

Supervisor `POST /api/customer-service/import` accepts JSON, maximum 500 messages. Require a stable requestId, explicit source/account scope and `from`/`to` dates as YYYY-MM-DD in Asia/Dubai. Every message must fall within that date interval. The import is one database transaction; an invalid/conflicting row commits none of the batch. Repeating a committed request with identical content/actor returns its saved result; changed content/actor conflicts.

Example with fictional values:

```json
{
  "requestId": "example-batch-0001",
  "source": "gallabox_export",
  "scope": "configured-account",
  "from": "2026-11-06",
  "to": "2026-11-06",
  "messages": [{
    "externalMessageId": "message-001",
    "externalConversationId": "conversation-001",
    "customerId": "CUST-EXAMPLE",
    "customerName": "Example customer",
    "externalAuthorId": "source-sender-001",
    "authorName": "Example customer",
    "authorType": "customer",
    "sentAt": "2026-11-06T06:00:00Z",
    "type": "text",
    "text": "Please check my discount code."
  }]
}
```

Message and conversation IDs are scoped to source/account. Staff identity never comes from a display name or a caller-supplied authorId. Existing validated internal customer IDs can link context; names alone cannot. Unknown audio/image evidence has no fake player, URL, duration or transcript. Good/Needs work requires selected mapped staff evidence; insufficient evidence is a separate non-negative result. Reviewers confirm an issue's selected message span; supervisors can split non-overlapping episodes without copying messages.

## Optional continuous normalized capture

Disabled by default. These interfaces implement a **normalized adapter contract**, not a verified native Gallabox payload adapter. Confirm actual provider payloads, history/media access, account entitlements and retry behavior before activation.

- `CUSTOMER_SERVICE_CAPTURE_ENABLED=true` enables `POST /api/customer-service-capture/normalized`.
- Set `CUSTOMER_SERVICE_CAPTURE_SECRET` privately. The sender supplies `x-matter-capture-signature`: base64 HMAC-SHA256 over the exact raw JSON bytes. Staff JWT is not a source signature.
- Payload uses the import contract above. Success means the transaction committed. The sender must retry failures with the same requestId; no delivery guarantee is inferred from an incoming event alone.
- Optional `CUSTOMER_SERVICE_FEED_URL` is an explicitly configured HTTPS normalized reconciliation feed, not an invented Gallabox API URL. Optional `CUSTOMER_SERVICE_FEED_TOKEN` stays server-side. `CUSTOMER_SERVICE_SYNC_MINUTES` is 5–1440, default 30; no feed URL means no polling job. Source event IDs/batch uniqueness make repeated processing safe across instances. A failed reconciliation does not advance coverage.
- Coverage remains partial/dated until historical and ongoing receipt are independently reconciled. A successful import is not proof of live completeness.

## Deliberately not activated or claimed

Native Gallabox backfill/assignment/media adapters and live chat reassignment have not been verified against the deployment's account. Business-hours/assignment clocks require real history and a configured calendar; unsupported clocks remain unavailable. Review effort estimates, complexity weighting and targets need a measured trial rather than invented quotas.

The app creates an on-demand XLSX. Conditional scheduled refresh of an existing shared Drive workbook is a remaining integration: it needs approved server credential facilities, verified read/version/write behavior, protection against human-edit conflicts and an agreed cadence. This PR does not overwrite an existing workbook or pretend that a downloadable export is scheduled synchronization.

## Verification and release

`.github/workflows/customer-service-ci.yml` runs service unit/isolated replica-set tests, focused client tests, production client build and real browser journeys using fictitious staff/customer records. Isolated tests require both `CUSTOMER_SERVICE_TEST_MONGODB_URI` and `CUSTOMER_SERVICE_TEST_ISOLATED=true`; they never fall back to production MONGODB_URI. Browser evidence contains fixtures only. No source keys are required or allowed in CI.

Mutations require MongoDB transactions and unique indexes. Verify the deployed replica set and new Service* indexes before enabling grants. Keep the feature unconfigured until source/environment identity, staff aliases, capacity, training, supervisor/deputy, trial scope/date and approval are recorded. Existing workspace users receive no workflow access simply by deployment.

Rehearse the three journeys: reviewer receives work, reviewer saves handling plus pending action, supervisor reassigns/follows up. Test a failed save/reload, new evidence, missing media, unavailable owner, simultaneous claim, date-filtered export and insufficient calibration. Compare review coverage, overdue backlog and verified closure against a compatible baseline before claiming a benefit.

Fallback: disable new allocations and continuous capture; preserve reviews, actions and history, and continue from the source inbox. Do not erase records or change customer subscription/delivery data as rollback. Merging main deploys this repository, so merge/deployment remains a separate authorized step.
