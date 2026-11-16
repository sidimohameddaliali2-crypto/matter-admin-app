# Matter application traceability

Implemented in Sidi's Delivery Admin source on 17 November 2026, from main commit `d4ad455`, rebased onto main `0ef5391`. This is a local implementation and synthetic verification record. Production activation, log storage settings and provider acceptance require their own verification.

The [route map](ROUTES.md) enumerates browser and API declarations with owning file/line references. The [JSON inventory](routes.json) also records response keys, inline status codes, referenced model/service calls, source digests, raw reporting dispatch evidence and Socket.IO event declarations. Regenerate it after changing a route or one of its owning files.

```sh
npm --prefix server run traceability:map
npm --prefix server run traceability:check
```

The normal server test suite checks that the generated map agrees with its source. The generator parses JavaScript and JSX without importing app entrypoints, connecting to databases, starting timers or contacting providers. Its input files are recorded by SHA-256 in `sourceDigests`. Static declarations include conditionally enabled routes. Registration order, nested routers and the Customer Service installer are preserved. Inline authorization predicates, indirect function calls, dynamic SDK behavior and imported report packages still require the linked source and runtime checks.

## Where to view it

In the app, open **Admin → Traceability** at `/traceability`. Access is restricted to `super_admin` in both browser navigation and the API. The Routes view searches the source inventory and shows access declarations, inputs, responses, service/model calls and source links. The Recent activity view searches request references and opens the associated trace records.

Recent activity is a bounded in-memory window for the responding server process, limited to 30 minutes and 2,000 safe structured events. It clears on restart and differs between PM2 processes. Process identity and retention appear in the UI. Refresh retrieves a new snapshot. A missing reference in one window requires checking the process logs or a future central collector. The local preview labels all synthetic traffic explicitly.

## How to follow a request

1. Reproduce the problem and read `X-Request-ID` on the response in browser Network tools. Staff, partner and member Axios clients also expose `response.requestId` or `error.requestId`. Rejected responses print that opaque reference and status in the browser console. Reloading creates new requests and references.
2. Search the API process's structured JSON output for that `request_id`. The `http.completed` record supplies the declared route template, method, elapsed time, status and outcome. URLs, query values, tokens and business payloads are excluded from this record.
3. Join `dependency.completed` records on `trace_id` or `request_id`. Nutrition and Truckoom outbound HTTP attempts are instrumented. `span_id` identifies an operation and `parent_span_id` joins it to the request or job that caused it. Cached responses can produce no outbound attempt. Provider transport completion can precede application validation of a provider's JSON result.
4. For scheduled work, search `job.started` and `job.completed` by `run_id`. Each execution has a fresh trace. Two runs with the same job name remain distinct. A started run without a completion can indicate process termination, unfinished work or missing logs. Check the process and scheduler before deciding which occurred.

This implementation restarts traces at the public HTTP boundary and does not trust caller-selected request IDs. It carries context within the Node process using AsyncLocalStorage. Trace headers are not sent to external providers. W3C propagation between approved first-party services and a collector/exporter are subsequent integration work.

## Interpreting diagnostic fields

| Field | Meaning and limits |
| --- | --- |
| `request_id` | Server-generated UUID for one HTTP attempt. A retry has a new request ID. This is a support reference and conveys no authorization. |
| `trace_id` | Random 32-character hex ID joining work within one execution. It conveys no business identity or proof of completion. |
| `span_id`, `parent_span_id` | Random 16-character operation IDs for parent-child relationships. |
| `run_id`, `job` | Random UUID per scheduled execution and a fixed job name. Run completion alone does not establish complete source coverage. |
| `route_id`, `route` | Source-derived method/path/file identifier and a static path template matched before dispatch. Conditional mounts or earlier handlers can change actual dispatch. Parameters stay placeholders. Raw delegated handlers use a declared boundary. |
| `status_code` | HTTP response or transport status. Zero represents a disconnect or transport failure without a received status. |
| `duration_ms` | Elapsed monotonic process time. Browser rendering, provider fix age and customer delivery time are separate clocks. |
| `completed` | The response finished or the wrapped operation returned. Inspect domain status, warnings, completeness and evidence separately. |
| `degraded` | The Truckoom vehicle route returned its existing fallback after the tracker dependency failed. Its HTTP response can remain 200. |
| `partial` | A job returned `complete: false` or a positive `failed` count. Other domain-specific partial outcomes still require service diagnostics. |
| `failed`, `server_error`, `timeout` | A wrapped operation failed, an HTTP response had a 5xx status, or a dependency reported a transport timeout. Raw error messages stay outside these new records. |
| `rejected` | An HTTP response had a 4xx status. This can represent denied access, invalid input, conflict, missing data or rate limits. |
| `disconnected` | The connection closed before response completion. The caller may retry after a write already committed. Check domain records and existing idempotency contracts. |
| `skipped` | Vehicle capture returned not-configured, already-running or already-claimed. A skipped run supplies no new capture. |
| `release` | Optional validated Git SHA from `MATTER_RELEASE_SHA`. Omitted when unset or invalid. |

HEAD can reuse a GET handler. Express may provide OPTIONS implicitly. Routes using `router.all` dispatch by method inside the handler. Statuses in the generated map come from inline `status`/`sendStatus` calls; default 200s, SDK responses, shared handlers and error middleware can supply additional statuses. Declared middleware is source evidence, not a permission audit. A GET can refresh caches or trigger background reads. Mutation routes can send notifications, upload evidence or write upstream even when no local database operation is visible inline.

## What the app areas mean

| Routes or browser area | Owning domain and interpretation |
| --- | --- |
| `/api/auth`, `/api/users`, `/api/drivers`, `/api/users/drivers` | Staff identity, roles, permissions, driver profiles and positions. The drivers router has two mounts. Staff authentication, authorization and assignment ownership are separate checks. GPS receipt time and device fix time must be read separately. |
| `/api/mobile/update-policy` | Client version/update policy. Availability says nothing about a particular device having installed an update. |
| `/api/deliveries` | Dispatch tasks, assignments, status, proof, timing and route planning. A Delivery model can represent Delivery, Task or Collection. A plan is a calculated proposal; assignment and driver submission are further operations. A saved delivered status records the app's accepted submission. Physical handover requires its own evidence. |
| `/api/deliveries/delivery-order` | Server-owned stop ordering. Revision/assignment checks in the linked handler govern competing edits. |
| `/api/truckoom`, `/api/vehicles` | Tracker observations, recorded history and vehicle/driver mappings. Tracker and phone positions have different provenance. A current mapping does not prove a historical assignment. HTTP 200 can include a tracker warning and phone-only fallback. Missing fix clocks remain missing. |
| `/api/upload` | Evidence/image upload. A successful upload does not prove that a later delivery status mutation referenced it or that an image establishes handover. |
| `/api/bags`, `/api/bag-operations`, `/api/store-keeper-scans` | Bag identities, custody movements, stock counts and scans. Movement event IDs provide existing domain deduplication. Diagnostic request IDs do not replace them. A scan and a completed transfer are distinct stored events. |
| `/api/bag-refunds`, `/api/bag-followups`, `/api/bag-notes` | Refund records, follow-up work and bag notes. An internal refund status must be reconciled with provider evidence before treating it as money moved. |
| `/api/reports`, `/api/alerts` | Operational aggregations and flagged-customer work. Check date ranges, filters, population and source freshness before interpreting totals. Missing rows are not automatically zeros. |
| `/api/delivery-changes` | Imported/manual delivery changes and application of those changes. Pending, accepted and applied describe different stages. The linked handler determines effective date and write effects. |
| `/api/events`, `/api/handoffs` | Event deliveries and van/bike handoff records. A saved handoff plan or status is an operational record with its own actor and revision rules. |
| `/api/communications`, `/api/incidents`, `/api/delivery-issues` | Staff communication and issue records. Logging a note or issue does not prove a customer notification or operational resolution. |
| `/api/menus`, `/api/meal-creation`, `/api/matter-core` | Menu catalogues, meal composition, kitchen production, uploaded core data and shared selection links. Effective dates, selected menus, exclusions and entitlements affect kitchen counts. Shared token routes can carry their own access scheme. |
| `/api/customers` | Operational customer profiles, addresses, import/matching and reminders. Local customer IDs and Nutrition subscription/customer identifiers belong to different systems. A matching result needs its source and ambiguity checks. |
| `/api/matter` | Delivery Admin's Nutrition/platform adapter. Sales snapshots, subscription detail, roster calculations, standardization and delivery import have different read/write and completeness contracts. Upstream Nutrition backend internals are outside this repository. |
| `/api/partner/auth`, `/api/partner`, `/api/admin/partners` | Partner login, member management, orders, invoices, waste and reports, plus staff administration. Partner authentication is separate from staff authentication. Read effective partner scope in each handler. |
| `/api/member/auth`, `/api/member`, `/join/:token` | Passwordless member registration and member ordering. The member middleware also supplies partner context for shared portal operations. Invitation validity and membership scope are separate from a browser page loading. |
| `/api/webhooks/customer-event` | Incoming source event persistence. A stored event is a receipt and does not by itself prove an effective delivery/subscription change. |
| `/api/employees` | Employee and leave-request records. These carry staff privacy requirements and separate permissions. |
| `/api/xero` | OAuth connection and invoice integration. Accepted accounting requests require the returned provider state and reconciliation before declaring accounting completion. |
| `/api/yellowblock` | Shopify-related orders, products, assets and third-party delivery assignments. Provider errors can surface independently of staff login. |
| `/api/external/deliveries`, `/api/external/drivers` | External read API using static API-key authentication. Its credential scheme is distinct from staff, member and partner tokens. |
| `/api/mcp`, `/api/mcp/oauth`, `/.well-known/*` | MCP commands, OAuth discovery, authorization, token exchange, registration and consent. A POST can execute a read command or an authorized mutation. Interpret its tool, scope and result in the MCP service. OAuth SDK middleware owns several protocol paths. |
| `/api/customer-service` | Canonical Supabase conversations, customer links, issues, episodes, requests, actions, rules, reviews and reporting. A conversation, an issue and a request are different records. Draft, submitted, provider-accepted and resolved states must be interpreted using their workflow contracts. A saved action does not prove a refund, pause or provider delivery. |
| `/api/customer-service-capture` | Readiness boundary in this app. The separate Gallabox worker and its instrumentation remain independently owned. The route inventory includes this boundary without asserting that capture endpoints are mounted here. |
| `/api/driver-audits/session`, `/api/reporting/*`, `/api/session*`, `/report-data/*`, `/report-assets/*` | Raw Driver Audit handler and imported reporting runtime. Session compatibility paths differ from app login. Imported/served report generations, source clocks, findings and review decisions each carry their own provenance. Raw dispatch literals/patterns appear separately in the map. |
| `/api/traceability` | Super-admin-only source catalogue and recent diagnostic events. A memory window is local to one server process and clears on restart. It supplies no durable cross-process history. |
| `/api/health`, `/api/test` | Process-level diagnostic responses. `/api/health` reports database connection state in its body and can still return HTTP 200 while disconnected. It is insufficient as a readiness or data freshness check. |
| Browser routes in `client/src/App.js` | The browser map records page elements and guard attributes. Browser guards control navigation; the API must independently enforce access. Loading the SPA shell is separate from a page's data requests completing. |

## Data vocabulary and source ownership

Mongo models in `server/models` own Delivery Admin's operational records. The inventory's `referencedCalls` identifies direct imported model and service method calls inside inline handlers. Service calls can add database writes and provider work beyond those direct calls. Review the linked handler and service before using a route as a read-only probe.

`Delivery` links operational dispatch, proof and timing. `Customer` stores an operational customer identity and addresses. `User` supplies staff identity, driver profile and permissions. Bag and movement records track physical bag custody. Weekly menu, selection and order records represent dated food choices and partner/member orders. Vehicle capture and tracker event records represent observations with source provenance. Customer Service's canonical Supabase records represent conversations and workflow state. Reporting generations and evidence hashes bind a report to its inputs and policy. None of these identifiers should be copied into diagnostic metric labels.

Staff `protect` authenticates identity. `authorize`, role shortcuts and `checkPermission` constrain permitted actions. Partner and member middleware resolve their own scopes. `apiKeyAuth` authenticates the external read API. Customer Service and Driver Audit also perform their own session/readiness checks. OAuth consent and MCP scopes form another authority boundary. The map retains guard declarations without treating the presence of a function name as proof that all branches enforce it.

## Background work and telemetry coverage

| Fixed job name | Existing schedule and result interpretation |
| --- | --- |
| `matter-delivery-import` | Opt-in `MATTER_IMPORT_ENABLED=1`; startup plus configured local daily hour. Processes tomorrow's schedule by default. Existing summary completeness/failed counts affect diagnostic outcome. |
| `driver-kpi-recalculation` | Daily local midnight. Recomputes month-to-date scorecards. A returned processed count is separate from field acceptance of the KPI policy. |
| `move-uncollected-collections` | Daily local midnight. Moves eligible assigned collections to the next day and resets assignment while retaining bag links and timeline. |
| `matter-sales-capture` | Starts after one minute when platform credentials are configured, then hourly. Retains prior observations on failure. |
| `vehicle-location-capture` | Startup and configured interval, minimum one minute. Distinguishes skipped, failed and returned runs; existing aggregate/evidence diagnostics supply row-level completeness. |
| `customer-tracker-visits` | Startup then every two minutes, guarded against overlap within the process. Existing service logs/data distinguish per-item failures swallowed by its internal logic. |
| `flagged-customer-notifier` | Startup then configured repeating interval. Individual Slack failures are caught inside the job. A completed job record alone does not establish delivery of every alert. |

Schedules, enabled flags, leases, retry behavior and notification authority remain governed by the existing job code. Instrumentation runs around each execution. It does not create a scheduler, replay, new worker or capture feed. Jobs started in multiple processes still require their existing concurrency contracts.

Express requests, including early raw handlers, malformed JSON, denied auth and static files, receive a request reference and a completion record. Server errors, caller errors and disconnected responses are distinguished. The Stock/Driver/Partner/Member UI, offline replay and direct fetch callers all reach this HTTP boundary when online. Only the three shared Axios clients attach the reference to their JavaScript result/error objects. Offline queue items, retry attempts and photo/status chains do not yet have a shared persisted diagnostic operation ID.

Socket.IO events are inventoried. Engine.IO bypasses Express request middleware, so the HTTP completion coverage does not include Socket.IO transport or individual event acknowledgement. Mongo/Redis/Postgres/Spaces calls, process resource metrics, browser rendering/errors, external worker internals and providers other than the instrumented Nutrition/Truckoom HTTP clients need further instrumentation. Existing business histories and reporting provenance continue to supply separate evidence.

## Privacy, operation and retention

New structured records use a fixed event/field allowlist and source-derived path templates. They exclude raw request/response bodies, URL queries, Authorization/Cookie headers, errors/stacks, customer/staff names, phone/email values, coordinates, files and provider secrets. Unknown routes are classified as a fixed unmatched/fallback template. The startup environment diagnostic now records presence of a Mongo connection setting instead of printing its URI prefix. New request references are never authentication credentials.

Logging is enabled by default with process stdout as its sink and a 30-minute, 2,000-event in-memory window for the super-admin UI. `MATTER_TELEMETRY_ENABLED=0` disables new structured records while request references remain available. Setting `MATTER_RELEASE_SHA` to a Git SHA adds release identity. Log-sink failures are contained. There is no added collector, database, external telemetry account or source-data export. Existing console statements elsewhere in the app have their own contents and require a separate review before forwarding entire process output.

The UI memory window enforces its own 30-minute and 2,000-event bounds. Durable log retention belongs to the selected process-log/collector infrastructure. Proposed starting limits are 14 days for diagnostic logs, 7 days for future sampled traces and 90 days for aggregate metrics, subject to an owner-approved storage/access policy. These periods are proposals and are not enforced by this patch. Business audit history, retained evidence and provider archives have independent policies.

Useful initial aggregates are request count, p95 duration, 4xx/5xx rate, degraded-200 count, dependency timeout/rejection rate, job last completion and start-without-completion counts. Group by fixed route, method, dependency, job and outcome. Keep request/trace/run IDs out of metric labels. Data freshness, queue age, processed/rejected totals, process health and source coverage need domain-specific measurements. Alert thresholds require a measured baseline.

## Verification and release

Synthetic tests exercise early raw handling, bad JSON, denied requests, errors, degraded HTTP 200, overlapping requests, dependency correlation, disconnects, safe log fields, sink failure and job outcomes. Browser-client tests exercise reference extraction on success, error and offline/no-response cases. The route check detects drift in inspected source. Server tests and a CRA production build are required before release. Actual production logging volume, host log retention, browser/device usability, provider behavior and cross-process propagation require post-deployment checks.

Customer Service impact assessment: this change adds a diagnostic HTTP response header and a client-side error reference across the shared app boundary. Its business workflow, permissions, provider actions, data definitions and staff-facing screens retain their current contracts. The existing shared Customer Service staff materials continue to describe those contracts. No customer-service acceptance or production/provider result is asserted by these diagnostics.

Local verification on 17 November 2026 used Node `v24.21.0`. The complete server suite passed 1,261 tests with 281 skipped. The complete client suite passed 713 tests in 90 suites. The CRA production build and source-map freshness check passed. A pre-existing asynchronous KitchenList PDF-export assertion failed in one complete client run, then passed in the focused recheck and final complete run. No KitchenList implementation or tests were changed. Actual browser/device and production acceptance remain unverified.

The UI extension was verified locally with 1,263 server tests passed and 281 skipped, 715 client tests passed across 91 suites, and a successful production client build. Synthetic browser checks covered route search, recent activity, trace detail, request-reference search, reload and a 390-pixel layout without page overflow or page errors. API tests checked unauthenticated/ordinary-admin denial, super-admin access, memory expiry and the 2,000-event bound. The local preview uses this app build with isolated synthetic identity and traffic; it does not connect to production storage or providers.
