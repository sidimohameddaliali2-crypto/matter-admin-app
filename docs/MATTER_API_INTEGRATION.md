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


## Kitchen subscription inputs and delivery comparison (2026-10-20)

Matter is authoritative for the kitchen customer's name, plan, daily meal and
snack entitlements, breakfast inclusion, nutrition targets, exclusions and saved
address/window. Recipes, assignments, approved portion formulas and explicit
kitchen adjustments remain local. Ordinary-plan meal frequency includes
breakfast; Matter Core counts main meals and handles breakfast separately, as
in the existing assignment/calculation rules. Cycle totals are not daily meals.
Missing values are not inferred from internal Customer defaults.

`GET /api/matter/subscriptions/kitchen-inputs?subscriptionId=...` requires staff
authentication. It fetches the exact subscription fresh, bypasses both nutrition
caches and performs no Customer relinking. Optional `customerId` cross-checks
identity. Without a subscription ID, customer/email discovery must yield exactly
one result; multiple subscriptions require an explicit link. A failed read does
not authorize exporting the previous inputs.

Kitchen and delivery imports share `resolveMatterDeliveryAddress`: one current
address wins; if none is current, exactly one active address is allowed. Multiple
current or active candidates remain unresolved. Address IDs and all structured
parts come from that same record. Unsupported categories retain their raw value
and have a null local location type. Unresolved kitchen addresses block final
papers. Export provenance identifies the subscription, address and source fetch
time and explicitly labels current snapshots as having unverified dated changes.

`GET /api/matter/subscriptions/:id/delivery-comparison?date=YYYY-MM-DD` is a
read-only dispatcher/manager/admin endpoint for one exact subscription and Dubai
service day. It compares subscription-linked jobs and same-day jobs belonging to
an explicitly linked Internal customer, including manual/CSV jobs. It returns
before/after conflicts, source fetch time, calendar eligibility, profile meal
conflicts and protected status. Multiple jobs are flagged for review; no stop is
created, relinked or modified. Name/email guesses are not used for this review.
Importer deduplication also returns comparison details rather than silently
hiding existing-job differences.

Approved saved manual pins are reused by new imports only when their saved
address identity and text both match the selected Matter address. New manual pin
corrections save this identity. Legacy cached corrections without an address ID
cannot safely be applied automatically. Existing jobs retain their corrections.

Remaining operational dependencies: Matter's current response does not establish
historical/future effective address/window state. Comparisons therefore report
`effectiveState: UNKNOWN` and remain review-only; no automatic reconciliation,
backfill or cutoff activation is implemented. Confirm the supported upstream
pending-change contract and Dubai activation cutoff before enabling dated apply.
The four historical roster exceptions require restricted evidence and owner
resolution. Runtime revision and live persistence/browser verification are still
required before closing issue #11. No production verification or writes were
performed for these changes.
