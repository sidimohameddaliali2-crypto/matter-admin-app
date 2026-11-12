# Customer Service integration

Customer Service is a new, separate page at `/customer-service/chats`. The existing Customers, Complaints, Reports, menus, delivery and other pages remain in place. Staff continue to use the app's existing login.

| Screen | Route | Preserved information |
| --- | --- | --- |
| Inbox | `/customer-service/chats` | Captured conversations, source messages/media, customer context, linked history and independent issues. |
| Follow-ups | `/customer-service/problems` | Accountable owner, next action, internal deadline, optional customer promise, waiting, saved outcomes and reopening. |
| Customers | `/customer-service/customers` | Existing identities, linked conversations and source history. |
| Reviews | `/customer-service/reviews` | Existing independent handling reviews and their audit history. |
| Summary | `/customer-service/summary` | Request outcomes, follow-up/review workload, response metrics and source coverage. |
| Reporting | `/customer-service/reporting` | Canonical request reports and evidence drilldowns; a permission-checked link opens the existing delivery Reports page. |

The optional private investigation-reporting package from the local development preview is not copied into this public repository. This integration does not replace the existing delivery reports or publish private evidence archives.

### Moving around the workspace

The six Customer Service destinations share a visible page bar on desktop and narrow screens. Inbox tools contains only inbox utilities; page links are not hidden there. Each destination has its own heading, browser title and current-page indicator. The existing admin Customers and delivery Reports pages remain separate destinations with their original permissions.

Inbox separates Conversations from My work. Browse history opens all captured conversation statuses and dates; Workbook excerpts remains a separate source choice under Filter conversations. Open/unassigned backlog queues span all dates, so their date controls are inactive with an explanation. Other pages use the collapsible Filter this page section, whose summary displays the current date scope.

Conversation, request, queue, source and work-view context travels in the workspace URLs alongside shared filters. Moving between pages, refreshing, and returning to Inbox retain that context. Back to conversations removes the selected conversation/request from the URL so a refresh returns to the list. Unknown workspace destinations show an explicit recovery link rather than silently displaying Inbox. These controls change navigation and view state; they do not grant access or save workflow commands.

## Storage and permissions

The server consumes the canonical Supabase archive and workflow in `gallabox_private`. IDs, source payloads, reviews and archived revisions stay there. No customer history is imported into a second application store, and this module starts no capture job, local publisher or provider-send service. Chat closure remains separate from issue resolution.

Page access uses the existing `customer_service` app permission, now also shown in the existing permissions editor. Each API request separately checks the active native account, an exact saved Matter-login link, active canonical staff membership and the applicable action grants. A generic administrator/page permission does not manufacture workflow authority.

`customerServiceAdminMount.js` verifies canonical writer ownership and the reviewed multi-issue index before enabling CS routes. Connection failure returns CS-only 503 responses while the rest of the app remains available. Startup never runs migrations, creates accounts or edits permissions.

## Release setup

The existing protected DigitalOcean deployment workflow is retained. Its `production` environment requires the owner's normal approval. `MATTER_CS_RUNTIME_B64` is an encrypted environment secret containing a base64 JSON object with the already verified canonical credentials (`projectRef`, `actualRegion`, `databasePassword`) and its verified `ca` certificate. Do not put the value in Git, logs or client variables.

After dependency installation and the client build, the workflow explicitly runs `node server/scripts/customerServiceDeploy.js --apply`. It:

1. Saves server-only credentials/CA under `server/.private/customer-service` with restrictive permissions and retains a backup of the original `.env.local`.
2. Adds only the three CS connection settings, preserving existing login, MongoDB and operational configuration.
3. Verifies the canonical runtime and multi-issue index without a migration or collector startup.
4. During initial setup, adds the new page permission only to active eligible existing accounts with exact, active canonical login/membership links. Role-default and explicitly configured access to every other page is preserved. A private initialization marker prevents future deployments from undoing a later administrator page-access revocation. Passwords, roles, workflow grants and source ownership are unchanged. A private before/after receipt supports review and rollback.

No database migrations are run by deploy or application startup. The reviewed `20261109120000_gallabox_request_issue_keys.sql` replaces only the single-origin unique index with `(originMessageId, originIssueKey-or-primary)` protection. It must be reviewed/applied separately and verified before deployment. Preserve all sibling requests when rolling back; never delete them to recreate an old uniqueness constraint.

## Verification and ongoing maintenance

Use `docs/customer-service/review-pack-maintenance.md` during affected changes. Keep the shared materials and existing staff inputs/history current in place. Synthetic engineering checks, actual staff acceptance and real provider behaviour are separate evidence.

Run the client suite/build, server service suite and explicitly isolated database suites. The destination integration tests use the actual mount plus the existing login router, and cover permitted/denied identities, multiple issues, saved outcomes, persistence, migration preservation and recovery. Do not run fictional write tests against the canonical live archive.

Local engineering verification does not approve unconfirmed company policies or claim a real refund/delivery happened. Recorded references are internal evidence; operational execution and provider capture remain independently verified paths.
