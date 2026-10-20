import express from 'express';
import { protect, authorize } from '../middleware/auth.js';
import matterApiService, { describeMatterApiError } from '../services/matterApiService.js';
import { detectAreaFromAddress } from '../config/areas.js';
import { getNutritionForCustomerLink } from '../services/matterNutritionLookup.js';
import { importMatterDeliveriesForDate } from '../services/matterDeliveryImportService.js';

const router = express.Router();

// List subscriptions (filterable, paginated)
router.get('/subscriptions', protect, async (req, res) => {
  try {
    const { page, page_size: pageSize, email, customer_id: customerId, updated_since: updatedSince } = req.query;
    const data = await matterApiService.listSubscriptions({ page, pageSize, email, customerId, updatedSince });
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API list subscriptions error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch subscriptions', error: error.response?.data || error.message });
  }
});

// Look up a subscription's macros/calories by customer email (used by Kitchen List)
router.get('/subscriptions/nutrition-by-email', protect, async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ success: false, message: 'email is required' });
    }
    const data = await matterApiService.getSubscriptionNutritionByEmail(email);
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API nutrition-by-email error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch subscription nutrition', error: error.response?.data || error.message });
  }
});

// Same as nutrition-by-email, but keyed by Matter subscription_id — for
// customers whose internal Customer.email doesn't match their Matter
// subscription's email (linked instead via Customer.matterSubscriptionId in
// Customer Management's "Internal Customer Match" panel).
router.get('/subscriptions/nutrition-by-subscription-id', protect, async (req, res) => {
  try {
    const { subscriptionId, customerId, email } = req.query;
    if (!subscriptionId && !customerId) {
      return res.status(400).json({ success: false, message: 'subscriptionId or customerId is required' });
    }
    // customerId (Matter's permanent id) is tried first, then the subscription
    // id, then email; whatever is found is saved back onto the Customer.
    const data = await getNutritionForCustomerLink({
      matterCustomerId: customerId,
      matterSubscriptionId: subscriptionId,
      email
    });
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API nutrition-by-subscription-id error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch subscription nutrition', error: error.response?.data || error.message });
  }
});

// Find active, non-cycle-ended subscriptions with a scheduled delivery on a
// given date, or across a date range when dateTo is also passed (per their
// own delivery_schedule). Expensive — checks every active/paused
// subscription's full detail — meant to be triggered on demand.
router.get('/subscriptions/delivery-on-date', protect, async (req, res) => {
  try {
    const { date, dateTo } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, message: 'date is required' });
    }
    if (dateTo && dateTo < date) {
      return res.status(400).json({ success: false, message: 'dateTo must be on or after date' });
    }
    const rows = await matterApiService.findSubscriptionsWithDeliveryInRange(date, dateTo || date);
    // Zone isn't a Matter field — derive it the same way the Matter delivery
    // import does (saved address's own area, else detect from the address text).
    const data = rows.map((s) => ({
      ...s,
      zone: s.address_detail?.area || detectAreaFromAddress(s.address || '') || ''
    }));
    res.json({ success: true, data });
  } catch (error) {
    const status = error.statusCode || error?.response?.status || 500;
    console.error('Matter API delivery-on-date error:', error.response?.data || error.message);
    res.status(status).json({ success: false, complete: false, code: error.code, discovery: error.discovery, message: describeMatterApiError(error) || 'Failed to check deliveries for date', error: error.response?.data || error.message });
  }
});

// Manually trigger the Matter delivery import for a specific date — the
// on-demand counterpart to jobs/importMatterDeliveries.js (which only runs
// automatically when MATTER_IMPORT_ENABLED=1, off by default; see that
// file's comment). Owner (2026-10-11): "I want the delivery for Monday to
// be fetch[ed] from the matter api." Idempotent/safe to re-run — see
// importMatterDeliveriesForDate's own comment (skips subscriptions already
// imported or already delivered another way, and now also skips any
// subscription with no address flagged current_delivery_address rather than
// guessing one).
// @route   POST /api/matter/import-deliveries   body: { date: "YYYY-MM-DD" }
router.post('/import-deliveries', protect, authorize(['admin', 'super_admin', 'dispatcher', 'manager']), async (req, res) => {
  try {
    const { date } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'date is required, as YYYY-MM-DD' });
    }
    const summary = await importMatterDeliveriesForDate(date);
    res.status(summary.complete === false ? 503 : 200).json({ success: summary.complete !== false, message: summary.complete === false ? 'Delivery import is incomplete; no complete result is available.' : undefined, data: summary });
  } catch (error) {
    console.error('Matter API import-deliveries error:', error.response?.data || error.message);
    res.status(500).json({ success: false, message: describeMatterApiError(error) || 'Failed to import deliveries from Matter', error: error.response?.data || error.message });
  }
});

// Every subscription (list-level fields only — status, plan name, cycle/renewal
// dates), paged through internally. Used for the subscriptions list's status
// tabs and the Reports view's counts/plan breakdown.
router.get('/subscriptions/all', protect, async (req, res) => {
  try {
    const data = await matterApiService.listAllSubscriptions();
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API list-all subscriptions error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch all subscriptions', error: error.response?.data || error.message });
  }
});

// Per-active-subscription financial fields (amount paid, currency), for the
// Subscription & Sales dashboard. Expensive — fetches full detail for every
// active subscription — meant to be triggered on demand.
router.get('/subscriptions/financials', protect, async (req, res) => {
  try {
    const data = await matterApiService.listActiveSubscriptionFinancials();
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API subscription financials error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch subscription financials', error: error.response?.data || error.message });
  }
});

// Per-active-subscription analytics fields (plan, created date, delivery
// zone), for the Customer Analytics & Reports page. Expensive — fetches full
// detail for every active subscription — meant to be triggered on demand.
router.get('/subscriptions/analytics', protect, async (req, res) => {
  try {
    const data = await matterApiService.listActiveSubscriptionAnalytics();
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API subscription analytics error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch subscription analytics', error: error.response?.data || error.message });
  }
});

// All active customers' contact info (name/email/phone/address), for export.
// Expensive — fetches full detail for every active subscription — meant to
// be triggered on demand.
router.get('/subscriptions/active-contacts', protect, async (req, res) => {
  try {
    const data = await matterApiService.listActiveCustomerContacts();
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API active-contacts error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch active customer contacts', error: error.response?.data || error.message });
  }
});

// Get a single subscription
router.get('/subscriptions/:id', protect, async (req, res) => {
  try {
    const data = await matterApiService.getSubscription(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API get subscription error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch subscription', error: error.response?.data || error.message });
  }
});

// Get a subscription's pause state
router.get('/subscriptions/:id/pauses', protect, async (req, res) => {
  try {
    const data = await matterApiService.getSubscriptionPauses(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API get subscription pauses error:', error.response?.data || error.message);
    res.status(status).json({ success: false, message: describeMatterApiError(error) || 'Failed to fetch subscription pauses', error: error.response?.data || error.message });
  }
});

// Pause/reschedule deliveries for a subscription — actually mutates a real
// customer's real delivery schedule.
router.post('/subscriptions/:id/pauses', protect, async (req, res) => {
  try {
    const { paused_days: pausedDays, chosen_days: chosenDays, reason } = req.body || {};

    if (!Array.isArray(pausedDays) || pausedDays.length === 0) {
      return res.status(400).json({ success: false, message: 'paused_days is required' });
    }
    if (!Array.isArray(chosenDays) || chosenDays.length !== pausedDays.length) {
      return res.status(400).json({ success: false, message: 'chosen_days must be provided and match paused_days in length' });
    }

    const data = await matterApiService.createSubscriptionPause(req.params.id, { pausedDays, chosenDays, reason });
    res.json({ success: true, data });
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error('Matter API create pause error:', error.response?.data || error.message);
    res.status(status).json({
      success: false,
      message: describeMatterApiError(error) || 'Failed to create pause',
      error: error.response?.data || error.message
    });
  }
});

export default router;
