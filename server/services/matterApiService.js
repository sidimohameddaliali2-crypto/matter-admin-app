import axios from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { cacheGet, cacheSet } from '../config/cache.js';
import { resolveMatterDeliveryAddress, matterMealContract } from './matterSubscriptionContract.js';

// A customer's macro/plan config on Matter changes on the order of days or
// weeks (subscription edits, pause/resume), not mid-shift — caching these
// lookups server-side (shared across every kitchen browser tab/staff member,
// unlike the client's per-tab cache) is safe at this TTL and is the single
// biggest lever on repeated-reload cost, since every uncached customer costs
// 1-2 live Matter API round trips.
const NUTRITION_CACHE_TTL_SECONDS = 15 * 60;

dotenv.config();

// Human-readable text for Matter's documented { error: { code } } responses.
const MATTER_ERROR_MESSAGES = {
  UNAUTHENTICATED: 'Matter API token is missing or invalid.',
  WRITE_NOT_ALLOWED: 'Matter restricts pause writes to a single pilot customer right now — this subscription is not yet in scope for write access.',
};

export function describeMatterApiError(error) {
  const code = error?.response?.data?.error?.code;
  const rawMessage = error?.response?.data?.error?.message || error?.response?.data?.message;
  if (code && MATTER_ERROR_MESSAGES[code]) return MATTER_ERROR_MESSAGES[code];
  if (rawMessage) return rawMessage;
  if (code) return `Matter API error: ${code}`;
  return null;
}

const formatAddress = (addr) => {
  if (!addr) return '';
  return [addr.building, addr.unit ? `Unit ${addr.unit}` : null, addr.floor, addr.area, addr.emirate]
    .filter(Boolean)
    .join(', ');
};

// A customer can have more than one saved address. Matter marks exactly one
// with `current_delivery_address: true` per subscription (verified live,
// 2026-09-22, across every multi-address subscription sampled) — that's the
// authoritative answer to "which address is this customer actually
// delivered to," so it's checked first. The completeness-based fallback
// below (found the same day via Maripet Cabauatan: two addresses, both type
// "secondary", one nearly empty besides emirate) only matters if a
// subscription somehow has no address flagged current — none seen in
// practice, but the fallback keeps this from ever returning nothing useful.
const ADDRESS_COMPLETENESS_FIELDS = ['area', 'building', 'street', 'unit', 'floor'];
const addressCompleteness = (addr) => ADDRESS_COMPLETENESS_FIELDS.filter((f) => addr?.[f]).length;

export function selectBestAddress(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  if (list.length === 0) return null;

  const current = list.find((a) => a.current_delivery_address === true);
  if (current) return current;

  const active = list.filter((a) => a.status === 'active');
  const pool = active.length > 0 ? active : list;
  const primary = pool.find((a) => a.type === 'primary' && addressCompleteness(a) > 0);
  if (primary) return primary;
  return pool.reduce((best, a) => (addressCompleteness(a) > addressCompleteness(best) ? a : best), pool[0]);
}


// Sorted YYYY-MM-DD dates of the subscription's active (not paused) deliveries.
// The Kitchen List derives FileMaker's "delivery number" from how many of
// these remain after a given day (see getDeliveryNumberFromRemaining in
// client kitchenListCalculations.js).
const activeDeliveryDates = (subscription) => (subscription?.delivery_schedule || [])
  .filter((entry) => entry?.status === 'active' && entry?.date)
  .map((entry) => String(entry.date).slice(0, 10))
  .sort();

// One shape for every nutrition lookup (by email, subscription id, or Matter
// customer id), so the Kitchen List gets the same fields whichever path found
// the subscription. customer_id is Matter's permanent id for the customer.
export const buildNutritionResult = (subscription) => ({
  delivery_address_resolution: resolveMatterDeliveryAddress(subscription.customer_addresses),
  meal_contract: matterMealContract(subscription),
  source_fetched_at: new Date().toISOString(),
  source_updated_at: subscription.updated_at ?? null,
  subscription_id: subscription.subscription_id,
  customer_id: subscription.customer_id ?? null,
  macros: subscription.macros || null,
  total_calories: subscription.total_calories ?? null,
  snacks_per_day: subscription.snacks_per_day ?? null,
  plan_name: subscription.plan?.name ?? null,
  // Per-day meal count — total_meals on the subscription is for the whole
  // cycle, not a daily figure (see WebsiteSubscription.js).
  meal_frequency: subscription.plan?.meal_frequency ?? null,
  breakfast_included: typeof subscription.breakfast_included === 'boolean' ? subscription.breakfast_included : null,
  // null when Matter sent no calendar at all, so "no deliveries" (empty list)
  // and "unknown" stay distinct for callers.
  active_delivery_dates: Array.isArray(subscription.delivery_schedule)
    ? activeDeliveryDates(subscription)
    : null,
  // The subscription's billing-cycle boundary — used by the menu-selection
  // screen's "last day of your cycle" banner/Renew prompt, and by
  // matterPauseResumeService to place a skipped day's resume day right after it.
  cycle_end_date: subscription.cycle_end_date ? String(subscription.cycle_end_date).slice(0, 10) : null,
  customer_addresses: subscription.customer_addresses || [],
  delivery_window: subscription.delivery_window || null,
  // Dietary restrictions — surfaced so the Kitchen List customer card can
  // display them.
  exclusions: Array.isArray(subscription.exclusions) ? subscription.exclusions.map((ex) => ex.title).filter(Boolean) : null,
  // Used to cross-reference this subscription against internal Customer
  // records (customerMatchService) when the subscription's own email
  // doesn't match anything internally.
  customer_name: subscription.name || null,
  phone: subscription.phone || null
});

class MatterApiService {
  constructor() {
    this.baseURL = process.env.MATTER_API_BASE_URL;
    this.token = process.env.MATTER_API_TOKEN;
  }

  client() {
    if (!this.baseURL || !this.token) {
      throw new Error('Matter API is not configured (missing MATTER_API_BASE_URL or MATTER_API_TOKEN)');
    }

    return axios.create({
      baseURL: this.baseURL,
      headers: { Authorization: `Bearer ${this.token}` },
      timeout: 15000
    });
  }

  /**
   * List subscriptions, optionally filtered by email/customerId/renewal date and paginated.
   */
  async listSubscriptions({ page = 1, pageSize = 50, email, customerId, updatedSince } = {}) {
    const response = await this.client().get('/subscriptions', {
      params: {
        page,
        page_size: pageSize,
        email,
        customer_id: customerId,
        updated_since: updatedSince
      }
    });

    return response.data;
  }

  /**
   * Get a single subscription by id.
   */
  async getSubscription(subscriptionId) {
    const response = await this.client().get(`/subscriptions/${subscriptionId}`);
    return response.data;
  }

  /**
   * Find a customer's active website subscription by email and return its
   * macros/calories/snacks_per_day/plan name/address/delivery window. The
   * list endpoint doesn't include these, so this looks up the subscription
   * id first, then fetches the full record.
   */
  async getSubscriptionNutritionByEmail(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const cacheKey = `matter:nutrition:v2:email:${normalizedEmail}`;
    const cached = normalizedEmail ? await cacheGet(cacheKey) : null;
    if (cached) return cached;

    const list = await this.listSubscriptions({ email, pageSize: 1 });
    const match = list?.data?.[0];
    if (!match) return null;

    const detail = await this.getSubscription(match.subscription_id);
    const subscription = detail?.data;
    if (!subscription) return null;

    const result = buildNutritionResult(subscription);

    if (normalizedEmail) await cacheSet(cacheKey, result, NUTRITION_CACHE_TTL_SECONDS);
    return result;
  }

  /**
   * Same shape as getSubscriptionNutritionByEmail, but for when the internal
   * Customer's email doesn't match their Matter website subscription's email
   * (e.g. Athleat/manual account setup used a different address). Customer
   * Management's "Internal Customer Match" panel links these two records by
   * setting Customer.matterSubscriptionId — when that's set, this looks the
   * subscription up directly instead of guessing by email.
   */
  async getSubscriptionNutritionBySubscriptionId(subscriptionId) {
    if (!subscriptionId) return null;
    const cacheKey = `matter:nutrition:v2:sub:${subscriptionId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const detail = await this.getSubscription(subscriptionId);
    const subscription = detail?.data;
    if (!subscription) return null;

    const result = buildNutritionResult(subscription);

    await cacheSet(cacheKey, result, NUTRITION_CACHE_TTL_SECONDS);
    return result;
  }

  /**
   * Same shape again, but keyed by Matter's customer id — the link that
   * survives renewals. A customer has one subscription at a time in Matter;
   * if there were ever several, the active one wins.
   */
  async getSubscriptionNutritionByCustomerId(customerId) {
    if (!customerId) return null;
    const cacheKey = `matter:nutrition:v2:cust:${customerId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const list = await this.listSubscriptions({ customerId, pageSize: 10 });
    const rows = list?.data || [];
    const match = rows.find((row) => row.subscription_status === 'active') || rows[0];
    if (!match) return null;

    const detail = await this.getSubscription(match.subscription_id);
    const subscription = detail?.data;
    if (!subscription) return null;

    const result = buildNutritionResult(subscription);
    await cacheSet(cacheKey, result, NUTRITION_CACHE_TTL_SECONDS);
    return result;
  }

  // Production kitchen reads deliberately bypass the 15-minute nutrition
  // cache and never relink Customer records. A known subscription is exact:
  // renewal/customer/email fallback could select a different paid entitlement.
  async getKitchenNutrition({ subscriptionId, customerId, email } = {}) {
    let id = subscriptionId;
    if (!id) {
      const list = await this.listSubscriptions({ customerId: customerId || undefined, email: customerId ? undefined : email, pageSize: 100 });
      const rows = list?.data || [];
      if (rows.length !== 1 || Number(list?.meta?.total_pages || 1) > 1) {
        const error = new Error('Kitchen subscription is ambiguous; link the exact Matter subscription before production.');
        error.statusCode = 409;
        throw error;
      }
      id = rows[0].subscription_id;
    }
    const detail = await this.getSubscription(id);
    if (!detail?.data || String(detail.data.subscription_id) !== String(id)) {
      const error = new Error('The exact Matter subscription could not be verified.');
      error.statusCode = 409;
      throw error;
    }
    if (customerId && String(detail.data.customer_id ?? '') !== String(customerId)) {
      const error = new Error('Matter customer and subscription links conflict.');
      error.statusCode = 409;
      throw error;
    }
    return buildNutritionResult(detail.data);
  }

  /**
   * Get the pause state for a subscription.
   */
  async getSubscriptionPauses(subscriptionId) {
    const response = await this.client().get(`/subscriptions/${subscriptionId}/pauses`);
    return response.data;
  }

  /**
   * Pause and reschedule deliveries for a subscription. This actually
   * reschedules a real customer's real deliveries — pausedDays and
   * chosenDays must be the same length (1-for-1 swap). A fresh idempotency
   * key is sent per call so retries can't double-apply.
   */
  async createSubscriptionPause(subscriptionId, { pausedDays, chosenDays, reason }) {
    const response = await this.client().post(
      `/subscriptions/${subscriptionId}/pauses`,
      { paused_days: pausedDays, chosen_days: chosenDays, reason },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } }
    );
    return response.data;
  }

  /**
   * Page through every subscription (the list endpoint caps at ~100/page).
   */
  async listAllSubscriptions() {
    const pageSize = 100;
    let page = 1;
    let totalPages = 1;
    const all = [];

    do {
      const result = await this.listSubscriptions({ page, pageSize });
      all.push(...(result?.data || []));
      totalPages = result?.meta?.total_pages || 1;
      page += 1;
    } while (page <= totalPages);

    return all;
  }

  /**
   * Find non-cycle-ended subscriptions (active, subscription-level paused,
   * or cancelled-but-still-within-their-paid-cycle) whose delivery_schedule
   * has an active entry somewhere in [startDateKey, endDateKey] (inclusive,
   * both "YYYY-MM-DD"). A subscription-level "paused" status doesn't
   * necessarily mean every day is skipped, so those are checked too — the
   * per-day delivery_schedule status is the real source of truth. "cancelled"
   * means the customer won't renew, not that service stops immediately —
   * they're still owed deliveries through cycle_end_date, so a cancelled
   * subscription is included on exactly the same cycle_end_date condition as
   * active/paused, never excluded outright. One row per (subscription,
   * delivery date) match. Checking delivery_schedule requires a full-detail
   * fetch per subscription (the list endpoint doesn't include it), so this is
   * expensive — hundreds of calls for a full customer base — and is meant to
   * be triggered on demand, not on every page load. Widening the date range
   * doesn't add extra calls: each subscription's full delivery_schedule is
   * already fetched in one shot and just gets checked against every date in
   * range.
   */
  async findSubscriptionsWithDeliveryInRange(startDateKey, endDateKey) {
    const all = await this.listAllSubscriptions();
    const candidates = all.filter((sub) =>
      ['active', 'paused', 'cancelled'].includes(sub.subscription_status)
      && String(sub.cycle_end_date || '').slice(0, 10) >= startDateKey
    );

    const CONCURRENCY = 20;
    const matches = [];
    const failures = [];

    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (sub) => {
        try {
          const detail = await this.getSubscription(sub.subscription_id);
          const schedule = detail?.data?.delivery_schedule;
          if (!Array.isArray(schedule)) throw new Error('Delivery schedule is missing');
          const deliveryDates = schedule
            .filter((entry) => {
              const d = String(entry.date).slice(0, 10);
              return entry.status === 'active' && d >= startDateKey && d <= endDateKey;
            })
            .map((entry) => String(entry.date).slice(0, 10))
            .sort();
          if (deliveryDates.length === 0) return [];
          return deliveryDates.map((deliveryDate) => ({
            subscription_id: sub.subscription_id,
            customer_id: sub.customer_id,
            // The list/summary endpoint's `name` can be sparser than the
            // full detail record (same reason `phone`/`address` below are
            // sourced from `detail.data`, not `sub`) — falling back to the
            // list row only if detail genuinely has nothing, so bulk name
            // matching (customerMatchService) doesn't silently miss a real
            // customer just because the summary row omitted their name.
            name: detail.data.name || sub.name,
            // Same reasoning as `name` above — email is the highest-
            // confidence matcher in customerMatchService, so it shouldn't be
            // more likely to be missing than the lower-confidence fallbacks.
            email: detail.data.email || sub.email,
            phone: detail.data.phone || '',
            address: formatAddress(resolveMatterDeliveryAddress(detail.data.customer_addresses).address),
            // Raw best-match address (building/floor/unit/coordinates) and
            // the delivery time window — detail is already fetched above for
            // every candidate, so surfacing these costs nothing extra. Added
            // for the Delivery-import job (matterDeliveryImportService.js),
            // which needs real coordinates/address parts and a wall-clock
            // time, not just the flattened display string.
            address_detail: resolveMatterDeliveryAddress(detail.data.customer_addresses).address,
            address_resolution: resolveMatterDeliveryAddress(detail.data.customer_addresses),
            source_fetched_at: new Date().toISOString(),
            source_updated_at: detail.data.updated_at ?? null,
            // Raw list too (not just the already-picked best one) — lets a
            // caller tell "exactly one plausible address, picked with zero
            // ambiguity" apart from "guessed among several candidates" (see
            // matterDeliveryImportService.js's unambiguousActiveAddress).
            customer_addresses: detail.data.customer_addresses || [],
            delivery_window: detail.data.delivery_window || null,
            meal_frequency: detail.data.plan?.meal_frequency ?? null,
            snacks_per_day: detail.data.snacks_per_day ?? null,
            breakfast_included: typeof detail.data.breakfast_included === 'boolean' ? detail.data.breakfast_included : null,
            exclusions: (detail.data.exclusions || []).map((ex) => ex.title).filter(Boolean),
            subscription_status: sub.subscription_status,
            plan_name: detail.data.plan?.name ?? null,
            cycle_end_date: sub.cycle_end_date ?? null,
            renewal_due_date: sub.renewal_due_date ?? null,
            renewal_eligible: sub.renewal_eligible ?? null,
            delivery_date: deliveryDate
          }));
        } catch (error) {
          console.error(`delivery-in-range check failed for subscription ${sub.subscription_id}:`, error.message);
          failures.push({ subscriptionId: String(sub.subscription_id), message: 'Unable to verify delivery schedule' });
          return [];
        }
      }));
      matches.push(...results.flat());
    }

    if (failures.length) {
      const error = new Error(`Delivery roster is incomplete: ${failures.length} subscription lookup(s) failed. Retry before preparing kitchen quantities or importing deliveries.`);
      error.code = 'INCOMPLETE_DELIVERY_ROSTER';
      error.statusCode = 503;
      error.discovery = { complete: false, candidates: candidates.length, verified: candidates.length - failures.length, failed: failures.length, errors: failures };
      throw error;
    }
    return matches;
  }

  /** Single-date convenience wrapper around findSubscriptionsWithDeliveryInRange. */
  async findSubscriptionsWithDeliveryOnDate(dateKey) {
    return this.findSubscriptionsWithDeliveryInRange(dateKey, dateKey);
  }

  /**
   * Fetches each subscription's full detail with bounded concurrency, maps
   * it through `mapFn`, and drops any that failed or mapped to null/[].
   * Shared by the "every active subscription's full detail" exports below —
   * they only differ in which fields they pull off the detail record.
   */
  async #fetchDetailsConcurrently(subs, mapFn, concurrency = 20) {
    const results = [];
    for (let i = 0; i < subs.length; i += concurrency) {
      const batch = subs.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(async (sub) => {
        try {
          const detail = await this.getSubscription(sub.subscription_id);
          const subscription = detail?.data;
          if (!subscription) return null;
          return mapFn(sub, subscription);
        } catch (error) {
          console.error(`Failed to fetch detail for subscription ${sub.subscription_id}:`, error.message);
          return null;
        }
      }));
      results.push(...batchResults.flat().filter((r) => r !== null && r !== undefined));
    }
    return results;
  }

  /**
   * All active subscriptions' contact info (name/email/phone/address).
   * Phone and address only exist on the full-detail record, so this fetches
   * every active subscription's detail — hundreds of calls — meant to be
   * triggered on demand (e.g. an export button), not on every page load.
   */
  async listActiveCustomerContacts() {
    const all = await this.listAllSubscriptions();
    const activeSubs = all.filter((sub) => sub.subscription_status === 'active');

    return this.#fetchDetailsConcurrently(activeSubs, (sub, subscription) => ({
      name: subscription.name || sub.name,
      email: subscription.email || sub.email,
      phone: subscription.phone || '',
      address: formatAddress(selectBestAddress(subscription.customer_addresses))
    }));
  }

  /**
   * Per-active-subscription financial fields (amount paid, currency) that
   * only exist on the full-detail record — the list endpoint has plan/cycle
   * dates but not payment info. Same cost profile as
   * listActiveSubscriptionAnalytics — hundreds of calls, on demand only.
   */
  async listActiveSubscriptionFinancials() {
    const all = await this.listAllSubscriptions();
    const activeSubs = all.filter((sub) => sub.subscription_status === 'active');

    return this.#fetchDetailsConcurrently(activeSubs, (sub, subscription) => ({
      subscription_id: sub.subscription_id,
      customer_id: sub.customer_id,
      email: subscription.email || sub.email,
      gross_paid: subscription.gross_paid ?? null,
      currency: subscription.currency ?? null
    }));
  }

  /**
   * Per-active-subscription analytics fields (plan name, created date, active
   * delivery zone) that only exist on the full-detail record. Same cost
   * profile as listActiveCustomerContacts — hundreds of calls, on demand only.
   */
  async listActiveSubscriptionAnalytics() {
    const all = await this.listAllSubscriptions();
    const activeSubs = all.filter((sub) => sub.subscription_status === 'active');

    return this.#fetchDetailsConcurrently(activeSubs, (sub, subscription) => {
      const activeAddress = selectBestAddress(subscription.customer_addresses);
      return {
        subscription_id: sub.subscription_id,
        plan_name: subscription.plan?.name || sub.plan?.name || null,
        created_at: subscription.created_at || subscription.starting_date || null,
        zone: activeAddress?.area || null
      };
    });
  }
}

export default new MatterApiService();
