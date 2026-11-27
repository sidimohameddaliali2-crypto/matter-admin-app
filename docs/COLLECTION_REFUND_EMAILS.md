# Accounts bag refund portal and daily reminders

## Current flow

Accounts receives at most one operational Brevo email per Dubai calendar day at accounts@matternutrition.xyz. The email summarizes the pending queue and opens /refund/portal#<capability>, with no staff login. The same active portal capability is reused across summaries. The portal lists all unpaid eligible collection requests with search and pagination. Jenniza chooses each refund, selects Credit/debit card or Bank account, enters its transaction reference, and explicitly confirms payment. The receipt and tracker retain Jenniza, the method/reference and the Accounts email-link source. No authenticated staff user ID is asserted by a no-login link, and no money is sent by the portal.

Eligible collections are collected/completed/delivered, request refund after collection, and do not record noBagsAvailable. Customers paid in either Collections or Bag Operations are excluded. Completion rechecks eligibility and paid status, then uses the existing expected version and unique customer deposit index. Old refunds remain readable without invented methods. Staff completion retains its signed-in actor.

## Daily email limit

RefundDailyDigest has a unique kind/dateKey index, one slot each for Accounts and Jana per Dubai day. Atomic leases coordinate manual requests and all PM2 instances. The server owns the stable UUID message key. The staff Email today's portal to Accounts button shares the automatic daily slot: repeated clicks cannot send another operational email that day. A requested portal invitation can be sent even with an empty queue and consumes today's Accounts slot. Explicit demo emails remain separate test actions and never run automatically.

The once-per-minute digest worker can send from 09:00 Dubai onward. Accounts receives one summary if there are pending refunds. If there are none at 09:00, the first eligible pending queue later that day can trigger the daily summary. New requests after that day's accepted summary remain visible immediately in the portal and appear in the next day's email. An empty queue does not trigger automatic emails.

Jana receives at most one daily Brevo email at the owner-confirmed jana@matternutrition.xyz, summarizing all requests still pending 48 hours or longer. The threshold uses collectionDetails.collectedAt, falling back to completedAt; assignment and follow-up notes do not restart the clock. Missing clocks are not invented. The summary includes total request count, up to 50 customer/ID/AED155/collection-time rows, and the staff tracker link for the complete queue. Cases completed before sending are excluded by a fresh unpaid query. A payment can still cross an in-flight provider submission; a notification does not prove the case is still pending when read.

Previously accepted per-refund emails on the same Dubai date consume the recipient's daily slot during migration. The former per-collection sender is no longer started; staff per-collection email endpoints also use the daily gate. Undelivered per-case Jana escalation records are cancelled with daily_digest_mode; accepted history is preserved.

## Adrian's 24-hour Slack reminder

A separate once-per-minute worker enrolls one durable adrian_24h stage per collection and sends once to directory-verified Adrian Fernandez (U047RL01DD1) after 24 elapsed hours while still pending. It rechecks eligibility/payment immediately before sending. There is no default-channel or webhook fallback. Existing SLACK_BOT_TOKEN needs chat:write; ENABLE_SLACK_NOTIFICATIONS=0 preserves a Slack pause. This integration's readiness must be verified on the live server; authorization in a connected chat plugin does not establish server bot permissions.

The message includes customer/ID, AED155, completed collection time and the staff tracker link. Neither Slack nor Jana's email contains an Accounts portal capability. Sent Slack stages do not automatically repeat. Known not-accepted/configuration failures defer 15 minutes. An uncertain Slack outcome or crash after attempting the send requires review rather than blind retries. No Slack deduplication guarantee is assumed.

## Capability and provider safeguards

The portal model and HMAC purpose differ from legacy single-record links. A single-record token cannot list or update the wider portal. Capabilities expire after seven days. Only their hash/derivation nonce are stored, excluded from ordinary reads; do not log them or copy real links into tickets/screenshots. API calls use a redacted token JSON field, no cookies or staff auth. Public entry points bypass staff stores/sockets/activity capture. The capability is in the fragment, not a request path or query. Responses are no-store/private, no-referrer, non-frameable and noindex. The API exposes customer name/ID, AED155, collection clock, version and only the selected completion receipt; it does not expose addresses, phones or staff permission objects.

Brevo calls reuse a stable UUID idempotencyKey. Uncertain retries stay within 20 minutes, below Brevo's documented 30-minute deduplication window, then require review. Daily slots are not replaced to work around uncertainty. Known rejected provider requests defer 15 minutes. Provider acceptance is not inbox-delivery confirmation. Staff can check Brevo/Slack readiness and inspect reminder state/error codes without credentials. Needs-review records are retained for investigation.

## Configuration

- Existing BREVO_API_KEY, verified BREVO_SENDER_EMAIL and optional BREVO_SENDER_NAME are reused.
- JWT_SECRET must be at least 16 characters. PUBLIC_APP_URL defaults to https://matterapp.online and accepts only a bare HTTPS origin.
- COLLECTION_REFUND_EMAILS_ENABLED=false pauses Accounts summaries/invitations.
- COLLECTION_REFUND_ESCALATIONS_ENABLED=false pauses Adrian reminders and Jana summaries.
- ENABLE_SLACK_NOTIFICATIONS=0 preserves the global Slack pause.
- Existing business date offset settings define Dubai day boundaries (default UTC+4), independent of server timezone.

## Demo and acceptance

/refund/portal?demo=1 lists two clearly labelled fictional pending refunds. Both can be completed and reset using only component state, with zero API/storage writes or messages. The earlier /refund/complete?demo=1 also opens this portal demo. Existing genuine single-record links remain scoped until expiry; no legacy access is silently broadened.

Fixtures cover portal scope/expiry, paid-customer and stale-write guards, destination/reference/Jenniza, multiple demo completions, 24h/48h clocks, cancellation, daily quotas under simultaneous/manual sends, Dubai midnight boundaries, migration-day quota, provider uncertainty and management guards. Build and deployment health do not prove inbox delivery or Slack delivery. Check the live server's bot scopes and Brevo sender separately. Do not invent overdue live cases or mark real refunds paid to prove a deployment.
