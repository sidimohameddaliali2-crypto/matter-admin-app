# Collection refund email links

Completed requested bag collections (`collected`, `completed` or `delivered`, with bags available) are scanned once a minute. A durable notification record is inserted once per collection. Refunds already recorded for that customer in Collections or Bag Operations are excluded. Existing pending requests are included when this feature starts.

Brevo sends to **accounts@matternutrition.xyz** only. The email names the customer, customer ID, recorded collection date and AED 155 deposit, with a private link to `/refund/portal#<capability>`. It never sends a staff login token. This Accounts-only capability grants access to all eligible pending collection refunds, expires after seven days and cannot change an already completed refund. The same active portal capability is reused across notification emails. Legacy single-refund links remain narrowly scoped until they expire; they cannot be used with the portal API. Email scanners can open the page without recording a refund: completion requires an explicit confirmation and a transaction reference.

The public entry point loads separately from staff Redux, login bootstrap, sockets and browser activity capture. The capability is in the URL fragment, not a query parameter or server path. API calls send it in a redacted JSON `token` field, without cookies or staff credentials. API responses are not cached; the public page uses no-referrer and cannot be framed. Only the customer name/ID, deposit, collection date, version and completion receipt are exposed.

Notification credentials are derived from a random nonce and the existing JWT secret using a separate HMAC purpose. Only a hash and the derivation nonce are stored, both excluded from ordinary model reads. Staff APIs return only notification status. Do not log capability values, copy them into tickets, or include them in screenshots of real requests.

## Configuration

- Existing `BREVO_API_KEY`, verified `BREVO_SENDER_EMAIL` and optional `BREVO_SENDER_NAME` are reused.
- `JWT_SECRET` must contain at least 16 characters.
- `PUBLIC_APP_URL` optionally sets the HTTPS origin; default is `https://matterapp.online`. It must not include a path, query, fragment or embedded credentials.
- `COLLECTION_REFUND_EMAILS_ENABLED=false` pauses automatic dispatch and staff email enqueueing. It does not revoke links already issued.

No payment provider is called. Completion records that Accounts reported the payment; the mailbox/link source is retained in refund history with the owner-requested display name Jenniza and the Accounts email-link source (no authenticated user identity is asserted). Staff completion and email-link completion use the same collection eligibility, optimistic version and unique customer-deposit safeguards.

## Sending, retries and staff controls

The worker uses MongoDB leases across application instances and a stable UUID `idempotencyKey` for Brevo retries. Brevo documents a [30-minute deduplication window](https://developers.brevo.com/docs/heterogenous-versions-batch-emails); automatic uncertain retries stop after 20 minutes and require staff review. A timeout is not proof of failure. Do not automatically issue a different message key for an uncertain send.

“Accepted by Brevo” means the API accepted the email; it is not an inbox-delivery confirmation. The Collection page displays queued, sending, accepted, uncertain, failed and needs-review states. Admins/managers can queue an email or explicitly confirm sending a replacement link. Per-collection resend creates a new notification generation and preserves notification events. It emails the current shared portal capability; it does not revoke the shared active portal. The shared capability is replaced when expired (or its signing secret changes). Sending is bounded to ten pending messages per worker pass. No periodic reminder emails are generated after a successful send.

## Acceptance

Local fixtures cover invalid/expired credentials, record scoping, stored-hash lookup, mandatory transaction reference/confirmation, stale writes, existing Bag Operations payments, terminal receipts, missing storage, Brevo acceptance/idempotency, uncertainty cut-off and insert-only automatic enqueueing. Public-page tests use no staff credentials. No real refund should be completed merely to test deployment.

Live verification must distinguish the website/API health and configuration from actual email acceptance and inbox delivery. If no eligible pending refund exists, the first real notification remains to be observed when a genuine collection becomes eligible. Tests and sandbox acceptance do not establish inbox delivery.

## Safe email demo

Management can use Send demo to Accounts to send a clearly labelled Brevo email only to accounts@matternutrition.xyz. The link opens /refund/portal?demo=1 with example data and no capability. The form makes no API calls, writes no storage and updates only component state. Reset/reopen returns to Pending. A real token takes priority if present. The authenticated send endpoint has no customer lookup, collection creation, link creation or ledger write; it accepts only a UUID send ID reused on retry for Brevo deduplication. Demo inbox delivery must be checked separately from API acceptance.

## Refund destination and named confirmation

New Done updates require a credit/debit card or bank account destination and a transaction reference, on both staff and public forms. The destination is stored on the refund and its immutable update-history event and included in staff CSV exports. Old refunds remain readable with Not recorded for an absent destination. The public checkbox explicitly says I, Jenniza, confirm; the server sets this owner-requested display name rather than trusting an incoming name. The receipt shows Confirmed by Jenniza. Actor type remains accounts_email_link, actor email remains the Accounts mailbox, and no staff user ID is asserted by the no-login link. Staff updates retain their actual signed-in actor. The safe demo displays the same checkpoint/name without API or storage writes.

## Accounts portal and overdue escalations

The portal lists all unpaid eligible collection refunds with paginated customer name/ID search, AED 155, collection timestamps, and expected versions. Completing a selected refund uses the same paid-customer check, unique deposit index, optimistic version, destination/reference validation and Jenniza audit as the earlier single-record flow. Pending rows refresh after completion and duplicate collection requests for a paid customer disappear. Portal and single-record credentials use separate HMAC purposes and separate models; an old single-record token never grants broader access. The demo lists two fictional pending records and supports both completions/reset without network, storage or messages. The earlier demo URL also opens the portal demo.

A separate once-per-minute Mongo-leased job enrolls pending requests. It uses collectionDetails.collectedAt, falling back to completedAt, as the original pending clock; owner assignment or follow-up notes do not restart it. Missing timestamps are not fabricated. At 24 elapsed hours it sends one Slack reminder to the directory-verified Adrian Fernandez (U047RL01DD1); at 48 elapsed hours it sends one Brevo email to the owner-confirmed jana@matternutrition.xyz. Each message includes the pending customer/ID, AED 155, collection time and the staff tracker URL. Escalations never include the no-login portal capability. Existing pending cases are included, and both stages may be due after downtime. Paid/ineligible cases are rechecked immediately before attempting delivery and cancelled. A concurrent payment can still cross an in-flight provider request; a notification cannot prove a case is still pending when read.

Unique delivery/stage records retain message IDs, attempts, due clocks, errors and states. Sent stages are never automatically repeated. Known not-accepted/configuration errors retry after 15 minutes. Uncertain Slack outcomes or crash recovery require review rather than automatic repeats. Brevo uncertain retries reuse one UUID within 20 minutes, then require review. No reliable Slack idempotency guarantee is assumed. COLLECTION_REFUND_ESCALATIONS_ENABLED=false pauses both stages; existing ENABLE_SLACK_NOTIFICATIONS=0 pauses Slack. Existing SLACK_BOT_TOKEN requires chat:write for the Adrian DM; no webhook/default-channel fallback is allowed. Accounts notifications and escalations are independent so an unavailable Slack integration does not block Jana email. Staff can inspect reminder readiness/states without exposing keys or portal tokens.

Acceptance: exercise portal scope, expiration, per-customer paid guards, stale writes, destination/reference/Jenniza, multiple demo completions, boundary deadlines, cancellation, leases and uncertain delivery with fixture-only providers. Check server Slack scopes and Brevo sender readiness separately from actual message delivery. Do not mark a real refund paid or invent overdue records to prove deployment.
