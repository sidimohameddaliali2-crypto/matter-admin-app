# Matter API integration

This app reads live subscription/nutrition/delivery data from Matter's own
backend (the website people subscribe through) and, in one place, writes to
it (pausing a subscription's deliveries). It's the source of truth for a
customer's macros, meal plan, snacks/day, breakfast inclusion, delivery
address/window, and subscription status — the internal `Customer` collection
in this app never duplicates that data long-term; it only caches it and
cross-references it.

- External API base URL: `https://backend-v2.matternutrition.xyz/api/v1`
- Auth: static bearer token, not a per-user login
- Code: `server/services/matterApiService.js` (the only place that calls
  Matter directly), `server/routes/matterApi.js` (exposes a subset to the
  authenticated client app), `server/services/matterNutritionLookup.js`
  (stale-subscription-id fallback, see below)

## 1. Configuration

Set in `server/.env` (or `.env.local` to override):

```
MATTER_API_BASE_URL=https://backend-v2.matternutrition.xyz/api/v1
MATTER_API_TOKEN=<bearer token>
```

If either is missing, `matterApiService.client()` throws immediately
(`Matter API is not configured...`) rather than making a request with no
auth — every call site should expect that error and surface it, not retry.

## 2. Calling it from server code

Always go through `matterApiService` (default export, already instantiated —
`import matterApiService from '../services/matterApiService.js'`). Never call
`axios` against Matter directly from a route; the service centralizes auth,
the 15s timeout, and error-message formatting.

| Method | What it does | Cost |
| --- | --- | --- |
| `listSubscriptions({ page, pageSize, email, customerId, updatedSince })` | One page of subscriptions (list/summary fields only — no macros, no address detail) | 1 call |
| `getSubscription(subscriptionId)` | Full detail for one subscription — macros, plan, addresses, delivery_schedule, exclusions, everything | 1 call |
| `getSubscriptionNutritionByEmail(email)` | Macros/calories/snacks/plan/meal_frequency/breakfast_included/addresses/delivery_window/exclusions/name/phone for the subscription matching this email | 2 calls (list then detail), **cached 15 min** per email |
| `getSubscriptionNutritionBySubscriptionId(subscriptionId)` | Same shape, looked up directly by subscription id (for a customer manually linked via `Customer.matterSubscriptionId` because their internal email doesn't match Matter) | 1 call, **cached 15 min** per subscription id |
| `getSubscriptionPauses(subscriptionId)` | Current pause state for a subscription | 1 call |
| `createSubscriptionPause(subscriptionId, { pausedDays, chosenDays, reason })` | **Writes.** Reschedules real deliveries — 1-for-1 swap, `pausedDays`/`chosenDays` must be equal length. Sends a fresh `Idempotency-Key` per call | 1 call |
| `listAllSubscriptions()` | Pages through the whole subscription list (list-level fields only) | N calls (~1 per 100 subscriptions) |
| `findSubscriptionsWithDeliveryInRange(startDateKey, endDateKey)` / `findSubscriptionsWithDeliveryOnDate(dateKey)` | Every active/paused/cancelled-but-still-owed subscription with a scheduled delivery in that date range, per its own `delivery_schedule` | Expensive — full detail fetch for every candidate subscription, concurrency 20. On-demand only, never on page load |
| `listActiveCustomerContacts()` | name/email/phone/address for every active subscription | Expensive — full detail for every active subscription. On-demand only |
| `listActiveSubscriptionFinancials()` | `gross_paid`/`currency` per active subscription | Expensive, on-demand only |
| `listActiveSubscriptionAnalytics()` | plan name/created date/zone per active subscription | Expensive, on-demand only |

Anything marked "expensive" exists because Matter's list endpoint doesn't
carry the field you need — there's no bulk endpoint for macros, addresses, or
delivery schedule, so getting that data for many subscriptions means one
detail call per subscription. Don't call these from a request that runs on
every page load; they're meant for export buttons / admin-triggered reports.

### Error handling

```js
import matterApiService, { describeMatterApiError } from '../services/matterApiService.js';

try {
  const data = await matterApiService.getSubscription(id);
} catch (error) {
  const message = describeMatterApiError(error) || 'fallback message';
  // ...
}
```

`describeMatterApiError` turns Matter's `{ error: { code, message } }`
response shape into readable text, with two codes specifically handled:
`UNAUTHENTICATED` (bad/missing token) and `WRITE_NOT_ALLOWED` (pause writes
are currently restricted to a single pilot customer on Matter's side).

### Resolving "which address do I deliver to"

A subscription can have several saved addresses. Use
`selectBestAddress(subscription.customer_addresses)` — it picks the one
flagged `current_delivery_address: true`, falling back to the most complete
active/primary address if none is flagged. Don't just take
`customer_addresses[0]`.

### Stale `matterSubscriptionId` (subscription renewals)

When a customer renews, Matter can issue a **new** subscription id — the old
one then 404s. Don't call `getSubscriptionNutritionBySubscriptionId` directly
for a customer with a manual link; go through
`getNutritionForLinkedSubscription(subscriptionId, email)`
(`server/services/matterNutritionLookup.js`) instead. On a 404 it retries by
email, and if that finds a different (newer) subscription id, it relinks
every `Customer` still pointing at the dead id — so the next lookup goes
straight to the right one, with no manual re-linking needed in Customer
Management.

### Caching

`getSubscriptionNutritionByEmail`/`BySubscriptionId` cache their result in
Redis (`config/cache.js`, `cacheGet`/`cacheSet`) for 15 minutes — shared
across every browser tab/staff member, not per-session. Macro/plan data
changes on the order of days, not minutes, so this is safe; a customer who
edits their plan on Matter's site may take up to 15 minutes to show the new
values in Kitchen List. Cached on success only — a `null`/not-found result is
never cached, so a customer who gets a subscription mid-shift isn't locked
out.

## 3. Internal HTTP routes (for the client app)

Mounted at `/api/matter` (`server/routes/matterApi.js`), all behind the
normal staff JWT (`protect` — see `middleware/auth.js`), none of these are
public:

| Route | Maps to | Used by |
| --- | --- | --- |
| `GET /subscriptions` | `listSubscriptions` | Subscriptions list page |
| `GET /subscriptions/nutrition-by-email?email=` | `getSubscriptionNutritionByEmail` | Kitchen List/Counting nutrition enrichment |
| `GET /subscriptions/nutrition-by-subscription-id?subscriptionId=&email=` | `getNutritionForLinkedSubscription` | Same, for manually-linked customers |
| `GET /subscriptions/delivery-on-date?date=&dateTo=` | `findSubscriptionsWithDeliveryInRange` | Kitchen auto-populate-missing job |
| `GET /subscriptions/all` | `listAllSubscriptions` | Subscriptions list status tabs, Reports counts |
| `GET /subscriptions/financials` | `listActiveSubscriptionFinancials` | Subscription & Sales dashboard |
| `GET /subscriptions/analytics` | `listActiveSubscriptionAnalytics` | Customer Analytics & Reports |
| `GET /subscriptions/active-contacts` | `listActiveCustomerContacts` | Contacts export |
| `GET /subscriptions/:id` | `getSubscription` | Subscription detail view |
| `GET /subscriptions/:id/pauses` | `getSubscriptionPauses` | Subscription detail view |
| `POST /subscriptions/:id/pauses` | `createSubscriptionPause` | Skip-a-delivery-day flow (menu selection link) |

Every route responds `{ success, data }` on success and
`{ success: false, message, error }` on failure, with the upstream Matter
HTTP status forwarded when available (so a Matter 404 reaches the client as
a 404, not a generic 500).

## 4. Cross-referencing Matter subscriptions with internal customers

Matter has no concept of this app's internal `Customer` records — matching
one to the other (so Kitchen List can pull live macros for a customer who
only exists internally, or so a menu-selection sign-in can find a
subscription by email) is handled separately by
`server/services/customerMatchService.js` (manual link → email → phone →
name cascade) — see that file's own comments, not duplicated here.

## 5. Known gotchas (learned the hard way, keep in mind before changing this code)

- **`meal_frequency` vs `total_meals`**: `subscription.plan.meal_frequency` is
  the per-day meal count; `subscription.total_meals` is for the whole
  billing cycle. Don't divide the wrong one by days.
- **`cancelled` subscriptions can still be owed deliveries.** A `cancelled`
  status means the customer won't renew, not that service stopped — they're
  owed deliveries through `cycle_end_date`. Every place that filters by
  subscription status (`findSubscriptionsWithDeliveryInRange`, etc.) includes
  `cancelled` alongside `active`/`paused`, gated on `cycle_end_date`, never
  excluded outright.
- **`subscription_status: 'paused'` doesn't mean every day is skipped** — the
  per-day `delivery_schedule[].status` is the real source of truth for
  whether a specific date has an active delivery.
- **List rows can be sparser than detail.** The list/summary endpoint's
  `name`/`email` can be blank even when the full detail record has them —
  bulk matching code prefers `detail.data.name`/`detail.data.email`, falling
  back to the list row only if detail has nothing either.


## Matter-only kitchen and menu identity (2026-10-20)

Matter's permanent `customer_id` is the kitchen account identity. A subscription
ID identifies a billing cycle and may change on renewal; it is a current source
reference, not a customer account key. Email verifies menu sign-in and discovers
the permanent ID. Subsequent customer lookups use that ID against Matter.
Exactly one active subscription can resolve a renewal; ambiguous or missing
results stay unresolved, rather than selecting by array position/name/phone.

`MenuSelectionRecord` stores per-menu meal choices, skips, notes and explicit
kitchen adjustments, keyed by `weeklyMenuId + matterCustomerId`. It retains
`matterEmail` and the current `matterSubscriptionId` for traceability. New records
have no Internal Customer reference. The partial unique index prevents creating
a second kitchen account when a subscription renews. No Internal Customer
collection read, create, update or save is part of kitchen preparation, menu
sign-in/submission, assignment, selection viewing, editing or deletion.
Existing legacy fields remain stored for history and are not customer profiles.
The Internal Customer Management meal-profile endpoints remain separate legacy
admin features; kitchen and menu clients do not call them.

Matter supplies customer names, contact/address/window details, plan, nutrition
targets, daily meal/snack entitlements, breakfast inclusion, exclusions and dated
delivery eligibility. Local menus/recipes/portion tables and approved selection
adjustments supply the food calculations. Ordinary meal frequency includes
breakfast; Core main meals and extra breakfast use the existing separate rules.
Core protein/carbohydrate targets are food weights; its missing fat target is
normal, and final meal macros come from the approved weight lookup. Required
missing fields cannot be replaced with Internal defaults. Allergies absent from
Matter are shown as unavailable. Legacy partner assignment based on Internal
Customer membership is disabled; these members need verified Matter accounts.

`GET /api/matter/subscriptions/kitchen-inputs` requires staff authentication and
accepts `customerId` (permanent Matter ID), or email for discovery. It reads Matter
fresh and never relinks Internal records. A legacy selection's captured
subscription ID may help establish a missing identity only when Matter still
verifies it. Unlinked old selections cannot be recovered by guessing an Internal
name or email. A stored selection by itself is not proof of a currently active
Matter account or of service on a particular day.

A confirmed empty subscription lookup by permanent customer ID returns
`MATTER_SUBSCRIPTION_UNAVAILABLE` (404), keeping the identity separate from
subscription availability. This does not prove whether an account was cancelled
or expired. After a complete selected-date delivery roster is verified, a linked
account absent from that roster is marked not scheduled and excluded from the
incomplete-production warning. An outage, partial roster, or missing identity
cannot trigger this exclusion. A renewed account is included as soon as Matter
schedules delivery for that date; cancelled accounts still owed a scheduled
delivery remain included too.

Selections GET also checks approved recovery archives. A recreated unlinked alias
is omitted only when its retained Matter-linked selection exists and it adds no
meal choices, notes, or pauses beyond the archived copy. Reads never delete or
recreate records. A changed alias remains visible for staff review. Old processes
must still be updated to stop writing the legacy copies.

Preparation (`POST /api/menus/:id/auto-populate-missing`, `freshInputs: true`)
performs a complete Matter roster/detail read. The date's calendar status governs
eligibility. Incomplete discovery fails before preparation can be called complete.
The same source read returns `kitchenInputs`, `kitchenRoster`, and `rosterComplete`;
these are reused by permanent customer ID rather than fetching every customer a
second time. Assignment writes only MenuSelectionRecord. Exact legacy records
identified by Matter email or a still-valid captured subscription can receive
the verified permanent ID there; Internal customer records are never consulted.
Multiple matching selections require review, and existing skips are preserved.
The summary cache excludes the source payload.

Both kitchen date controls select the same day; reselecting it preserves loaded
selections. Immediate day downloads reuse that exact verified load version for
up to 60 seconds, including source timestamps and current local adjustments.
They still verify roster coverage and required portion inputs. Different dates,
older versions, failed refreshes and incomplete preparation require a fresh
Matter read. This is bounded request-local memory, not persistent/offline data.
Download progress/errors appear next to the buttons, and failures can be retried.

Address resolution is shared: one current address wins; without a current flag,
exactly one active address is allowed. Multiple candidates remain unresolved.
Address identity, written details and coordinates stay together. Unsupported
categories retain their source value with a null local location type.

`GET /api/matter/subscriptions/:id/delivery-comparison?date=YYYY-MM-DD` remains a
bounded, read-only dispatch/admin comparison of a saved delivery and Matter.
This separate delivery reconciliation endpoint may inspect Internal delivery and
profile records; it is not used by kitchen/menu customer lookup. It never applies
changes. Matter currently supplies no proven historical/future address/window
activation contract, so dated comparisons report UNKNOWN. Future cutoff behavior,
historical exceptions and live runtime/persistence verification remain separate
requirements before closing issue #11. No production migration/backfill or live
customer correction was performed for this change.

### Shared kitchen and delivery names/windows (2026-10-21)

`POST /api/matter/standardize-deliveries` takes `{ date: "YYYY-MM-DD" }`
and is restricted to admin, super admin, dispatcher and manager roles. The
delivery page calls it in the background on date selection/refresh. Saved rows
load immediately; changed rows are reloaded after synchronization. Requests for
the same date are coalesced and successful results reused for 60 seconds.

For today's/future Matter deliveries, a complete Matter date roster supplies
the name and delivery window. Matching uses the permanent
Matter customer ID, with an exact subscription link allowed for older rows.
Internal profiles supply identity links only. Ambiguous/missing accounts are
reported without guessing. Names use the same casing rule as kitchen output;
window minutes and Dubai date boundaries are preserved. Updates change only
name, scheduled time and Matter identity references, with concurrent edit/status
guards. In-flight records are retained. Owner explicitly approved replacing
completed historical names and scheduled times with current Matter values on
2026-10-21, starting with the week of October 12; earlier dates remain intact.
Historical views resolve the current full subscription by permanent
customer identity, not an expired subscription or name/email guesses. These are
current values, not evidence of a historical window. Stored early/late fields
and affected driver KPIs are refreshed when the scheduled time changes; actual
completion times are preserved. This synchronization does not apply address,
pin, driver or route changes.
