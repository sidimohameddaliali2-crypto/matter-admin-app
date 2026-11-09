# Gallabox cloud capture and metrics

Capture runs in Supabase project `trhhjfgfmxofxhnzocks`, isolated in `gallabox_private`. The authenticated `gallabox-capture` function is dispatched every 30 seconds by `gallabox-capture-30s`. Its provider calls are GET-only. Driver/reporting tables and the existing `matter-reporting` function are outside this migration.

Incoming and historical jobs have separate durable cursors. Incoming pages run first. A lease prevents overlapping workers; failures retain checkpoints and back off. Source IDs, timestamps and BSON payload hashes are preserved. Replaced records are archived. Capture does not rewrite existing human reviews, actions or classifications. New identities stay unmatched unless verified saved evidence exists. A database trigger prevents the old local publisher from overwriting source records after cloud cutover.

The local preview reads message history from Supabase. Its existing staff-command/authentication engine still requires a local cache of users, reviews, issues, customer directory and actions. Commands publish to Supabase before acknowledgement. Bulk message/capture collections may be deleted after cloud execution and digest verification; the remaining transactional cache and credentials are not disposable downloads.

Response-time aggregates refresh in Supabase every five minutes, separately from the 30-second incoming capture schedule. Their source timestamp is returned as `responseMetricsAsOf`; current queues and capture health are read live.

## Measures implemented

- Average, median and 90th-percentile human response waits, overall and by recorded staff sender.
- All headline and per-staff response measures use the owner's corrected 08:00–17:00 Dubai schedule, daily. Days off and holidays have not been configured. Off-hours contribute zero working seconds.
- Answered turns, turns without a recorded human reply, and uncertain-author turns.
- Open and unassigned-open contact groups, independently classified.
- Capture run durations, errors, last success, provider reads, live/history queue depth and saved-message counts.
- Capture latency for real messages sent after cloud activation and captured on the incoming lane. Zero samples means no observed arrival, not zero latency.
- Existing review workload, issue categories and overdue/unassigned follow-ups remain separate from provider chat status.

A turn starts with the first incoming message after the preceding human reply; consecutive customer messages share one wait. Bots, confirmed away replies, system events, reactions and internal notes do not count as human replies. Unknown outgoing authors make the measurement uncertain. Metrics use captured native messages, never fabricated messages from summary rows. An unanswered final “thanks” is not automatically an SLA breach. The first observed reply is not necessarily the first-ever reply when earlier history is missing. Averages cover observed answered turns only: show unanswered and uncertain counts alongside them.

## Further fields and measures

| Measure | Evidence or definition needed |
| --- | --- |
| Response SLA / breaches | Agreed target, shift hours, holidays and complete incoming coverage |
| Time unassigned / first owner / transfers | Timestamped assignment/unassignment events and verified actors; current ownership alone is insufficient |
| Resolution time / reopening | Open/resolve/reopen events plus a separate staff-confirmed issue outcome; a closed chat does not prove the underlying problem was solved |
| Follow-up completion / overdue duration | Owner, due time, completion time and completion evidence |
| Repeat complaint / category volume | Verified identity, reviewed issue boundaries and categories; messages are not issues |
| Refunds / cancellations / retention | Linked transaction and subscription outcomes, not inferred sentiment |
| CSAT / confirmed resolution | Actual customer feedback; no invented satisfaction scores |
| Shift productivity / first daily staff message | Agreed shifts, availability and denominators; a first message is not attendance proof |
| After-hours volume | Raw timestamps plus agreed hours; workbook totals remain reported until reconciled |
| Read/unread / time to read | Read-state events, absent from the verified discovery response |

The supplied three-month workbook reports 794 reviewed problems, 10,733 incoming messages, 2,565 after-hours messages and 3,163 answered waits. These are workbook-reported totals, not independently verified equivalents of native capture metrics. Reconcile periods, coverage, working-hour rules, messages versus turns and uncertain authors before comparing them.

## Coverage limits

Discovery reads each authorized channel's recent 100-conversation window and OPEN-filtered window. Previously tested page/offset/skip parameters repeated the discovery window; unlimited discovery remains unverified. All 663 already verified native contact identities are queued for historical reads. Message reads request up to 100 rows per page, with a local safety cap of 1,000 pages. An empty page establishes exhaustion of the available window at that moment, not lifetime retention. Offset pages can move during arrivals; repeated scans and deduplication do not create an atomic provider snapshot. Conflicting immutable evidence is retained rather than guessed or overwritten.

## Recovery

Pause only `worker_control.enabled`; retain cloud ownership to keep stale local source writers fenced out. Re-enable to resume checkpoints. Never enable the old source publisher over an old local snapshot. Restores require verified hashes and an isolated cache. Vault credentials and private tables must not be exposed to browsers.

Current acceptance evidence and removal receipts are in `tmp/qa/inbox-verification.md`.

## Cloud workflow cutover — 8 November 2026 Dubai

`worker_control.workflow_mode=cloud` makes Supabase authoritative for issues, reviews, follow-ups, staff workflow memberships, command receipts and allocation state. The local API reads/writes those records directly. Transactions serialize with hosted capture, retain previous payloads in `inbox_record_history`, enforce version checks and make duplicate commands replay safely. A database trigger rejects stale local workflow publishers. Cloud outages fail closed; they do not create a second local workflow.

The verified cutover retained 15,244 reviews, four existing workflow memberships, one command receipt and allocation state. No pre-existing follow-up records were present. The old local review collection remains an inactive recovery copy; it is not read or updated by the cloud workflow.

Six account-verified Gallabox staff identities populate follow-up ownership. The hosted capture worker refreshes this private directory from authorized provider reads. Names are never used to guess login matches. These provider identities are not yet linked to app-authenticated users: the local preview still uses explicitly labelled QA sign-ins, and quality-review eligibility remains governed by existing authenticated memberships. Shared app authentication was deliberately not changed because other products use it.

The full write journey is verified in an isolated PostgreSQL test database with empty local workflow collections; real-source cloud records are read and hash-checked without submitting fabricated reviews or follow-ups. Cloud worker v8 successfully ran and refreshed the directory after deployment. The main app remains local.

## Verified staff sign-in and list performance — 8 November 2026

The dedicated local inbox uses `installServiceLogin` with the existing Supabase reporting identity provider or Matter `/api/auth/login` and `/api/auth/me`. No driver authentication, user password or reporting membership is changed. Customer-service permissions are a separate projection with only `customerService: true`. Supabase sessions are validated upstream and checked against active `auth.sessions`, refreshed as needed, and encrypted with a separate private local key. The real inbox no longer accepts the QA shortcut or requires QA users at startup.

`gallabox_private.staff_login` binds immutable provider subjects to the same canonical Gallabox staff IDs used by follow-ups. Jacob and Alaa were linked by exact account-email matches. The owner explicitly confirmed the different-email matches for Saleek, Adrian and Mariolle. Five real staff identities now have customer-service memberships; Jacob is the supervisor. Review capacity remains undeclared (zero); no fabricated time allocation or historical assignments are introduced. Jana has no verified app-login match and is excluded from new follow-up owner choices until linked. Existing review and ownership history remains intact.

Two performance causes were measured: stable `convert_from(hex)` SQL expressions prevented partial-index use (2.3-second archive scan versus <1 ms indexed membership lookup), and list pages loaded the full report. Escaped constant SQL literals now allow indexes. Reviews fetch the signed-in user's own records. Follow-ups are separately paged, and issue choices are bounded/searchable. Summary reads only the fields needed for its measures. `message_time` is a compact, trigger-maintained index in the same transaction as canonical message writes, not a periodically refreshed copy. Its 137,415 rows reconciled with all canonical message timestamps/conversation IDs, with zero mismatches at verification.

Existing local previews remain local; no app deployment was performed. Five login links are configured, but a fresh password sign-in by each individual staff member has not been observed. The owner's existing real Supabase session was independently verified and exercised in the browser. Jana's existing login, if any, still needs identification.
