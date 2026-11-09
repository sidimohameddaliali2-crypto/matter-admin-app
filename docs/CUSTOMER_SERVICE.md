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

## Native Gallabox connection (read-only)

The supervisor Summary page now supports **Check Gallabox account**, **Load recent conversations**, and **Capture recent messages**. All provider requests are GET requests; the capture writes only local Service* evidence/reviews through the existing transactional importer. It does not send messages, reassign the inbox, or change Matter customers/subscriptions/deliveries. Reviewers and unenrolled administrators cannot invoke these endpoints. Loading the page does not automatically call Gallabox.

Configure these server-only values privately in server/.env.local:

- CUSTOMER_SERVICE_GALLABOX_API_KEY
- CUSTOMER_SERVICE_GALLABOX_API_SECRET
- CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID
- CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID (optional channel restriction)

These are deliberately separate from the legacy GALLABOX_* renewal-send configuration. Never put secrets in REACT_APP_* variables or a browser form. The fixed provider origin is https://server.gallabox.com; redirects are rejected, reads time out, response sizes are bounded, and upstream error bodies are not sent to the UI.

The [official users API](https://developers.gallabox.com/gallabox-api/users) establishes account access. Authenticated bounded checks on 6 November 2026 independently verified GET /devapi/accounts/:accountId/conversations and GET /devapi/accounts/:accountId/messages?channelId=...&contactId=... for this account. These undocumented response shapes are covered by fictional fixtures, not committed customer captures.

**Coverage is partial.** Recent conversation discovery can return a limited window (100 or 20 records observed); `page=2` and `page=3` repeated identical conversation records, so they are not used to claim exhaustive discovery. Message pages were independently verified through an empty terminal page. Manual capture reads up to 25 pages / 500 messages for the selected conversation. Automatic sync checkpoints one bounded page at a time, validates account/channel/contact, detects repeated pages, preserves original IDs/timestamps and imports before advancing its checkpoint. A 1000-page safety limit records a partial scan and permits a fresh pass. Empty terminal pages do not establish source retention or snapshot consistency.

Native names/phone numbers never imply a Matter customer link. Staff attribution requires verified provider sender identity; application staff mapping remains explicit. Broadcast/unknown authors remain unassessed. Supported images, audio and video use protected on-demand local playback. The server validates exact `files.gallabox.com/{account}/{file}` URLs, MIME and 20 MB maximum, follows no redirects and forwards no provider credentials. Issue authorization precedes media lookup/fetch. Provider URLs remain server-side; browser blobs are revoked on navigation/retry. Expired, absent and unsupported attachments remain explicit.

Capture retries preserve the UI request ID. Completed requests replay their saved receipt before contacting Gallabox again, bound to the original operator, account/channel and conversation. A fresh request fetches new evidence and safely deduplicates source messages. Provider display names may change; existing message labels are preserved when stable sender identities match, while changed message content still conflicts. A failed capture never appears as successful. Source health, UI and exports identify native captures as partial.

Customer-service APIs are network-only in the service worker. Activation removes older customer-service cache entries while retaining existing delivery cache entries. Offline customer-service requests return 503 and cannot replay another account's cases. The real-browser cache regression covers upgrade cleanup and continued offline driver delivery reads.

## Automatic native sync and historical recovery

`CUSTOMER_SERVICE_GALLABOX_SYNC_ENABLED=true` explicitly enables the native scheduler. It is disabled by default and independent of the existing renewal-message integration and normalized-feed scheduler. The local preview enables it directly. Account and channel are required. Discovery runs every thirty seconds; saved pages use an expiring fenced database lease, exponential retry backoff and idempotent source-message imports. Discovery failures do not block saved page work. Status is visible in Summary and survives restarts. No outgoing messages, provider assignments or other product models are changed.

`queueGallaboxHistory({bytes,from,env})` accepts the original conversation export and explicit timezone-bearing history start. It validates account/channel and derives unique contacts, then durably queues all their message pages across actual native conversation IDs. Workbook hash and normalized start time prevent duplicate queueing. Source page limits/errors remain visible. This recovers accessible source history; it does not assert the provider retained every message.

`extractCustomerServiceHistory.js` and `importLocalCustomerServiceHistory.js` preserve curated workbook transcript evidence separately as `gallabox_history`. Actual message IDs and cell/file/row provenance are retained, repeated cells deduplicated, conflicting observations quarantined. Overlapping transcript groups are synthetic and labelled in the UI, never asserted to be native conversations. Do not add counts across historical and native sources as globally unique messages. Import and replay preserve existing reviews and unrelated collections. Local import requires an explicit loopback test database; originals are unchanged.

## Optional continuous normalized capture

Disabled by default. These interfaces implement a **normalized adapter contract**, not a verified native Gallabox payload adapter. Confirm actual provider payloads, history/media access, account entitlements and retry behavior before activation.

- `CUSTOMER_SERVICE_CAPTURE_ENABLED=true` enables `POST /api/customer-service-capture/normalized`.
- Set `CUSTOMER_SERVICE_CAPTURE_SECRET` privately. The sender supplies `x-matter-capture-signature`: base64 HMAC-SHA256 over the exact raw JSON bytes. Staff JWT is not a source signature.
- Payload uses the import contract above. Success means the transaction committed. The sender must retry failures with the same requestId; no delivery guarantee is inferred from an incoming event alone.
- Optional `CUSTOMER_SERVICE_FEED_URL` is an explicitly configured HTTPS normalized reconciliation feed, not an invented Gallabox API URL. Optional `CUSTOMER_SERVICE_FEED_TOKEN` stays server-side. `CUSTOMER_SERVICE_SYNC_MINUTES` is 5–1440, default 30; no feed URL means no polling job. Source event IDs/batch uniqueness make repeated processing safe across instances. A failed reconciliation does not advance coverage.
- Coverage remains partial/dated until historical and ongoing receipt are independently reconciled. A successful import is not proof of live completeness.

## Deliberately not activated or claimed

Native recent conversation/message reads were verified locally against the configured account. Historical recovery and supported media retrieval are implemented locally; full source retention remains unverified. Assignment writes and live chat reassignment are not implemented. Business-hours/assignment clocks require real history and a configured calendar; unsupported clocks remain unavailable. Review effort estimates, complexity weighting and targets need a measured trial rather than invented quotas.

The app creates an on-demand XLSX. Conditional scheduled refresh of an existing shared Drive workbook is a remaining integration: it needs approved server credential facilities, verified read/version/write behavior, protection against human-edit conflicts and an agreed cadence. This PR does not overwrite an existing workbook or pretend that a downloadable export is scheduled synchronization.

## Verification and release

`.github/workflows/customer-service-ci.yml` runs service unit/isolated replica-set tests, focused client tests, production client build and real browser journeys using fictitious staff/customer records. Isolated tests require both `CUSTOMER_SERVICE_TEST_MONGODB_URI` and `CUSTOMER_SERVICE_TEST_ISOLATED=true`; they never fall back to production MONGODB_URI. Browser evidence contains fixtures only. No source keys are required or allowed in CI.

Mutations require MongoDB transactions and unique indexes. Verify the deployed replica set and new Service* indexes before enabling grants. Keep the feature unconfigured until source/environment identity, staff aliases, capacity, training, supervisor/deputy, trial scope/date and approval are recorded. Existing workspace users receive no workflow access simply by deployment.

Rehearse the three journeys: reviewer receives work, reviewer saves handling plus pending action, supervisor reassigns/follows up. Test a failed save/reload, new evidence, missing media, unavailable owner, simultaneous claim, date-filtered export and insufficient calibration. Compare review coverage, overdue backlog and verified closure against a compatible baseline before claiming a benefit.

Fallback: disable new allocations and continuous capture; preserve reviews, actions and history, and continue from the source inbox. Do not erase records or change customer subscription/delivery data as rollback. Merging main deploys this repository, so merge/deployment remains a separate authorized step.

### Local Matter directory and identity reconciliation

The customer page reads a separate `ServiceCustomer` directory, with an atomic
active-generation manifest. It does not populate or change the operational
`Customer` collection. Matter subscription pages are reconciled against their
reported totals. Delivery customer snapshots merge only on explicit Matter IDs;
phone/email matches link Gallabox contacts without merging directory records.
Unmatched conversation groups are counted separately from directory customers.

The local preview refreshes the full Nutrition customer database, Matter API subscriptions,
and retained Supabase history at startup and every 30 minutes while running. It does
not use an expiring admin session or start production background jobs. The full source
reader is restricted to the isolated loopback preview database and read-only identity
queries. It counts users, subscriptions and offline imports in one consistent snapshot,
preserves exact historical identity evidence and excludes deleted/anonymized users
from automatic matching. Historical subscription rows without an eligible user are
counted separately; their presence does not create new customer identities.

The owner explicitly approved the existing private environment's REQUIRED TLS mode
for this local source reader. It encrypts traffic without verifying the server certificate;
CUSTOMER_SERVICE_MYSQL_REQUIRED_MODE_APPROVED=true is required alongside
CUSTOMER_SERVICE_MYSQL_ENABLED=true. This does not change another product's TLS policy.
The Supabase connection continues to verify its certificate using the existing private
credentials and CA paths in server/.env.supabase.local.

Each complete full-database and subscription-API read is separately committed to
customer_service_private.live_source and independently read back with a verified hash
before local publication. The private table has no public client grants. Older generations
cannot overwrite newer ones. The historical source_private import remains unchanged;
its records retain their original dates. Incomplete source reads and storage/readback
failures retain the previous good observations and report unavailable sources. Failed
API reads retain the previous directory generation. Matching by historical phone never
merges customers; reviewed canonical bridges require explicit source customer IDs.

Source times are separate, and count reconciliation does not claim an atomic
cross-source snapshot. Rounded scientific-notation phone values are never repaired
by inventing digits, and ambiguous identities are not forced into customer matches.
Contact mapping runs while the opted-in Gallabox worker is active. Conflicting
matches retain their prior identity for review and do not silently move chats.
Curated workbook observations retain their original text, type and time. Verified
source account plus exact native message IDs provide identity links; representation
differences remain visible in the reconciliation audit. Groups with incomplete or
conflicting identities remain unresolved. Multiple source contacts can share a
history group only when every message has exact native provenance and every contact
currently matches the same canonical customer. All contact and generation fences
are checked before publication; original workbook groups and reviews are retained. Submitted reviews are retained.

All customer-service pages open on Today in Dubai. All time and custom dates are
explicit choices preserved across navigation and reload. Filtered review claiming
respects the selected scope and preserves an existing out-of-scope draft.

Identity normalization removes a single national trunk zero only when the UAE
country code is already explicit (`97105xxxxxxxx` → `9715xxxxxxxx`). Bare
nine-digit numbers are not assigned a country. Matching still checks all canonical
records; correcting a format can expose a real shared-phone ambiguity instead of
choosing an account. Original source phone strings remain preserved.

Reviewed native endpoint proofs can resolve a multi-number contact only for an
explicit, digest-bound set of conversations. They validate the authenticated source
account/channel/contact, each message's sender or recipient endpoint, and a unique
current directory phone. A malformed endpoint may join a canonical endpoint only
through the exact provider recipient ID within the same reviewed source evidence;
no suffix or country inference is used. Contact ambiguity flags remain intact.
The `reviewed_scoped` state cannot auto-assign future conversations. New/changed
messages, revoked proofs or new directory collisions invalidate the proof; history
and customer-context routes revalidate coverage instead of trusting a saved label.

A separate manually reviewed `account_email_screenshot` proof can resolve an exact
native conversation when a customer supplies a successful account-selection
screenshot with an email unique to one current eligible account. It binds the
reviewed image bytes, original media URL and native source message hashes, plus the
complete conversation digest. OCR output, failed login screens and historical-only
email aliases do not authorize this proof. Raw contact attributes and competing
phone candidates remain visible; the proof does not assign future conversations.
A historical group remains unresolved unless every message is covered by the
validated scope, even when some messages have account-specific evidence.

### Captured conversation inbox

Active customer-service members can browse captured native conversations through
`GET /api/customer-service/conversations` without holding a review assignment.
Native chats are the default; `source=history` opens imported excerpts separately,
and `source=all` explicitly includes both source representations. Historical
excerpts retain their grouping warning and source provenance.

Conversation lists use a bounded cursor ordered by latest message time and ID.
`GET /conversations/:id` returns the latest message page in chronological order;
its cursor loads older messages, while an uncursored refresh reads recent arrivals.
Conversation-scoped attachment access validates membership and message ownership
before fetching the protected source media. Neither endpoint returns review records.
Pending independent calibration hides issue judgments and follow-up annotations,
including sibling issue annotations and category-filter matches. Existing review,
classification, action creation, ownership and transfer permissions remain unchanged.

Verified locally on 2026-11-07: discovery must send `channelId` to obtain each authorized channel window. This account returned 20 conversations by default and 100 when `limit` was supplied; tested `page`, `offset`, and `skip` repeated that window. Contact-message `page` pagination did advance and exhaust. These observations do not establish full account enumeration or retention. See the private local verification record for coverage and recovery evidence.

Incoming capture now has a durable `liveQueue`/`liveCompleted` lane independent of historical cursors. Discovery changes enqueue/reset the live page-one cursor even when the same contact is already being scanned. Each worker step reads one live page first and then one historical page. Live catch-up stops on an empty or wholly saved page; this is not a full-retention checkpoint. Historical scans still continue to their own empty page. Live retries and timestamps are exposed separately; a 30-second worker-local staff-directory cache reduces provider reads without caching messages or discovery. Discovery remains a 30-second poll, not a latency SLA or webhook.

Native capture does not choose between conflicting automatic directory and saved customer associations. When native thread/contact IDs agree, source messages are retained, the saved association/reviews remain intact, and captureIdentityConflict hides the asserted customer identity in the source inbox until reviewed. Explicit customer-ID conflicts and conflicting native contact IDs still reject.

### Private Supabase inbox storage (local opt-in)

`customerServiceCloudRuntime.js` enables cloud reads only when
`CUSTOMER_SERVICE_STORAGE=supabase`. The local source preview uses the existing
Matter reporting Supabase project, but only the new `gallabox_private` schema.
No reporting or driver tables are written. Browser clients never receive database
credentials; staff authorization and calibration visibility remain server-side.

The cloud copy stores every Service* message, conversation, review revision,
action, capture receipt and sync checkpoint with its original BSON payload and
SHA-256. Publication is atomic. Changed evidence and reviews retain previous
versions. The inbox list, paginated history and media metadata read Supabase;
an unavailable cloud read fails rather than silently showing a stale local copy.

The existing transactional Mongo worker cache is retained locally. Capture and
review saves publish before acknowledgement; a background publisher retries
changes every two seconds after the previous attempt finishes. This interval is
not a guaranteed provider-arrival latency. Gallabox capture still needs the local
worker running. No hosted worker or webhook is deployed by this change.

`server/scripts/customerServiceCloud.js migrate|verify|restore` requires explicit
`CUSTOMER_SERVICE_CACHE_MONGODB_URI` on loopback and `CUSTOMER_SERVICE_CACHE_DB`,
plus the existing private Supabase credentials/CA path variables. It never uses
production MONGODB_URI. Restore requires an empty service cache and validates
payload hashes and a stable cloud revision. Preserve the original cache until
readback, recovery and inbox verification complete; do not run multiple writers
against one published origin. Staff authentication accounts remain outside this
archive and must be configured independently when recovering a new machine.

Large local Gallabox evidence files can be retained in
`gallabox_private.local_artifact_archive` as gzip/base64 with their original
SHA-256 and byte count. Delete a local file only after reading the cloud payload
back, decompressing it and matching both values, then rechecking that the local
file has not changed. These are private evidence archives, not inbox messages.
Keep the original supplied spreadsheet and required local credentials separately.

### Provider inbox queues (local, 2026-11-08)

Gallabox conversation `status=OPEN` maps to Open; `CLOSE` maps to Resolved.
Assignment is independent: the verified native response omits `assigneeId` for
unassigned conversations. A known assignee ID maps to Assigned. Unsupported or
missing status on a partial record remains Unknown, never silently Open.
Provider assignment is not local review assignment or follow-up ownership.
Automatic replies do not change either field. Read/unread is unavailable in the
verified conversation response and is not inferred from message direction.

Discovery reads both the recent 100-conversation window and the separately
verified `status=OPEN&limit=100` window for each authorized channel. It unions
native IDs, includes older open contacts, and preserves the latest provider
conversation state under `sourceMetadata.providerInbox`. New source conversations
can be listed before their first history page arrives; no message is fabricated.
The native contact group displays this state while retaining all thread IDs and
all historical messages. Neither a short page nor a successful request proves
unbounded provider retention or discovery pagination. Historical groups with no
current observation remain explicitly unavailable in the status filters.

The local inbox defaults to Open, with a separate Assignment filter. Open or
Unassigned queues ignore report date limits so unresolved work does not disappear
at midnight. Resolved/All views retain the chosen date filter. Filters are applied
before cursor pagination in both Mongo and Supabase readers; detail views keep
all historical threads. The browser polls without claiming/reassigning reviews.

### Remaining cloud execution boundary

Supabase currently stores and serves inbox data; the capture, reconciliation and
review transaction engine still executes in the local Node/Mongo worker. This is
not Mac-independent sync. No hosted worker or schedule has been deployed.

A complete hosted cutover still requires moving the capture transaction/lease and
checkpoint operations into private Postgres, running bounded read-only Gallabox
polling in a hosted worker, and disabling the old Mongo publisher before the new
writer takes ownership. Two independent publishers must not overwrite each
other's versions. Keep provider writes/sends disabled and retain the existing
review revision archive. A Supabase Cron-triggered Edge Function is a supported
hosting option (https://supabase.com/docs/guides/functions/schedule-functions),
but a schedule alone cannot run the existing Mongo-dependent worker. Do not
activate it or claim sleep/offline acceptance until a cloud-only capture test
passes with the Mac worker stopped. The existing no-deployment instruction
remains in force; this section records unfinished work, not a deployed design.

### Unified request workflow (local review)

The inbox uses the existing private Supabase archive and workflow transaction. A source conversation is not automatically a confirmed issue. Assignment-authorized staff register an identifiable request from an actual customer message, assign an accountable linked staff member, and set its next action and due time. Ordinary staff cannot self-assign. Request follow-ups are visible on Follow-ups and link back to the same request. Existing reviews and legacy action records remain accessible.

Assignment, policy configuration, exception decisions and sensitive closure are separate grants. An exception decision must be independent of its requester. Closure requires topic-specific completed effects and evidence; a Gallabox resolve event never closes a request. Explicit related evidence can reopen only the chosen request. Saves use version checks and idempotent commands; polling cannot silently upgrade a draft's version. A conflict retains the draft and requires explicit review before retry.

Use `REACT_APP_API_URL=/api GENERATE_SOURCEMAP=false npm --prefix client run build`, then `node server/scripts/customerServicePreview.js` from the repository root. The existing private `server/.env.supabase.local` and `.env.service-auth.local` supply access; no secrets belong in source control. The preview binds loopback only, starts no driver jobs or customer-message sends, and uses no local operational database. Cloud capture runs independently. No fixture sessions are installed by this entry point.

History details show the provider scan checkpoint. A pending history job may be a periodic recheck. An exhausted provider page is not proof of retained completeness: conversation discovery is a recent/open window, and previously observed page/offset/skip parameters repeated it. Missing source identities, expired/deleted attachments, and messages absent from the provider must remain explicit gaps. Curated workbook summaries must never be turned into invented messages.

08:00–17:00 Dubai is the agreed response-time window. Working days, holidays and SLA thresholds remain unconfirmed; unknown enforcement rules remain inactive. Existing window-only response figures must not be interpreted as a confirmed working-calendar SLA.

Do not merge this branch into `main` without an authorized release: `.github/workflows/deploy-digitalocean.yml` deploys every push to `main`.
