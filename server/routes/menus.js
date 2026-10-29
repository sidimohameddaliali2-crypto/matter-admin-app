import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import { effectivePermissions } from '../models/User.js';
import Partner from '../models/Partner.js';
import MenuItem from '../models/MenuItem.js';
import KitchenBreakfastPreset from '../models/KitchenBreakfastPreset.js';
import KitchenSnackPreset from '../models/KitchenSnackPreset.js';
import { snackPresetUpdate } from '../services/kitchenSnackPresets.js';
import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import MenuSelectionArchive from '../models/MenuSelectionArchive.js';
import { excludeRecreatedArchivedAliases } from '../services/archivedMenuAliases.js';
import { protect } from '../middleware/auth.js';
import { isMatterCoreDoubleDay } from '../utils/matterCoreDelivery.js';
import { appendKitchenMeals } from '../services/kitchenSelectionWrite.js';
import { kitchenDateUnavailable } from '../services/kitchenDeliveryEligibility.js';
import { toKitchenOption, kitchenConflictList, kitchenConflictFields, mergeKitchenMetadata } from '../services/kitchenExclusions.js';
import { kitchenUpload } from '../services/kitchenUpload.js';
import { saveManagedMenu } from '../services/managedMenuSave.js';
import { assertAssignmentMacros } from '../services/kitchenMacroValidation.js';
import { readKitchenState, beginKitchenState } from '../services/kitchenProductionSnapshot.js';
import { assertKitchenSelectionClosed, readKitchenSelectionWindow } from '../services/kitchenSelectionDeadline.js';
import { cacheGet, cacheSet, cacheDelete, cacheDeletePattern } from '../config/cache.js';
import { FIXED_SELECTION_DEADLINES } from '../config/selectionDeadlines.js';
import athleatService from '../services/athleatService.js';
import matterApiService, { describeMatterApiError } from '../services/matterApiService.js';
import supyService from '../services/supyService.js';
import { withKitchenPreparation, preparationHasFailures, kitchenPreparationFailure } from '../services/kitchenPreparation.js';
import { matterSelectionIdentity, matterSelectionFilter, normalizeMatterEmail } from '../services/matterKitchenIdentity.js';
import { resolveMenuAllergyProfile } from '../services/menuAllergyProfileService.js';
import { getPartnerKitchenOrders } from '../services/partnerKitchenOrders.js';
import { syncMenuSelectionMainMealsToPartnerMenu } from '../services/menuSelectionPartnerSync.js';
import { previewSkipPauses, applyConfirmedPauses, resolveSubscriptionContext, validateRequiredResumeDates, expandSaturdaySkips } from '../services/matterPauseResumeService.js';


const router = express.Router();

// Read-only production feed for both Kitchen List and Kitchen Counting.
router.get('/kitchen-partner-orders', protect, (req, res, next) => {
  const permissions = effectivePermissions(req.user);
  if (!permissions.kitchen_list && !permissions.kitchen_counting) {
    return res.status(403).json({ success: false, message: 'Kitchen access is required.' });
  }
  next();
}, async (req, res) => {
  try { res.json({ success: true, data: await getPartnerKitchenOrders(req.query.date) }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Partner kitchen orders could not be loaded.' }); }
});

const toDayKey = (value) => {
  if (!value) return '';
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
};

// Add `days` calendar days to a "YYYY-MM-DD" string, returning "YYYY-MM-DD".
const addDaysToDateKey = (dateKey, days) => {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const isWeekendKey = (dateKey) => {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
};
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const buildEmailRegex = (email) => {
  const cleaned = String(email || '').trim();
  return new RegExp(`^${escapeRegex(cleaned)}$`, 'i');
};

const isValidObjectId = (value) => mongoose.isValidObjectId(value);

// menuItemId is an optional ObjectId ref — meals with no linked catalog item
// (e.g. auto-assigned snacks/main meals) legitimately have none. Mongoose
// accepts `undefined` for an optional field but throws a cast error on `''`,
// so this normalizes any falsy/empty value to undefined before it's ever
// assigned to a document.
const toMenuItemId = (value) => {
  const raw = (value && typeof value === 'object' && value._id) ? value._id : value;
  return raw === '' || raw === null || raw === undefined ? undefined : raw;
};

const buildMealName = (item = {}) => {
  const provided = String(item.mealName || '').trim();
  if (provided) return provided;

  const parts = [
    String(item.proteinSource || '').trim(),
    String(item.carbs || '').trim(),
    String(item.veg || '').trim(),
    String(item.sauce || '').trim()
  ].filter(Boolean);

  return parts.length ? parts.join(' | ') : '';
};

const normalizeBreakfastKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const normalizeBreakfastPresetEntry = (raw = {}) => {
  return {
    breakfastName: String(raw.breakfastName || '').trim(),
    C: Number(raw.C ?? raw.carbs ?? 0) || 0,
    P: Number(raw.P ?? raw.protein ?? 0) || 0,
    F: Number(raw.F ?? raw.fats ?? 0) || 0,
    V: Number(raw.V ?? raw.vegWeight ?? 80) || 80,
    isLargeBreakfast: !!raw.isLargeBreakfast
  };
};

const parseKitchenBreakfastPreset = (menuDoc) => {
  const breakfastPreset = normalizeBreakfastPresetEntry(menuDoc?.breakfastPreset || menuDoc?.breakfastMacros || {});
  return {
    breakfastName: breakfastPreset.breakfastName,
    C: breakfastPreset.C,
    P: breakfastPreset.P,
    F: breakfastPreset.F,
    V: breakfastPreset.V,
    isLargeBreakfast: breakfastPreset.isLargeBreakfast
  };
};

const parseKitchenBreakfastPresetsByName = (menuDoc) => {
  const source = menuDoc?.breakfastPresetsByName;
  if (!source) return {};

  const pairs = source instanceof Map
    ? Array.from(source.entries())
    : Object.entries(source || {});

  return pairs.reduce((acc, [rawKey, rawValue]) => {
    const key = normalizeBreakfastKey(rawKey);
    if (!key) return acc;
    acc[key] = normalizeBreakfastPresetEntry(rawValue || {});
    return acc;
  }, {});
};

// Global, name-keyed snack macro table (see KitchenSnackPreset). Each entry
// is that snack's own fixed C/P/F, used directly wherever the name matches —
// never divided by snacksPerDay, unlike the per-date Snack Rotation list.
const normalizeSnackKey = normalizeBreakfastKey;

const normalizeSnackPresetEntry = (raw = {}) => ({
  snackName: String(raw.snackName || raw.name || '').trim(),
  C: Number(raw.C ?? raw.carbs ?? 0) || 0,
  P: Number(raw.P ?? raw.protein ?? 0) || 0,
  F: Number(raw.F ?? raw.fats ?? 0) || 0
});

const parseKitchenSnackPresetsByName = (doc) => {
  const source = doc?.presetsByName;
  if (!source) return {};

  const pairs = source instanceof Map
    ? Array.from(source.entries())
    : Object.entries(source || {});

  return pairs.reduce((acc, [rawKey, rawValue]) => {
    const key = normalizeSnackKey(rawKey);
    if (!key) return acc;
    acc[key] = normalizeSnackPresetEntry(rawValue || {});
    return acc;
  }, {});
};

const normalizeKitchenMacros = (rawMacros) => {
  if (!rawMacros) return { C: 0, P: 0, F: 0, calories: 0 };

  if (rawMacros.total) {
    return {
      C: Number(rawMacros.total.C) || 0,
      P: Number(rawMacros.total.P) || 0,
      F: Number(rawMacros.total.F) || 0,
      calories: Number(rawMacros.total.calories) || 0
    };
  }

  return {
    C: Number(rawMacros.C) || 0,
    P: Number(rawMacros.P) || 0,
    F: Number(rawMacros.F) || 0,
    calories: Number(rawMacros.calories) || 0
  };
};

// ============================================
// CUSTOMER MEAL DATA ROUTES
// ============================================

/**
 * GET /api/customers/:customerId/meal-profile
 * Fetch customer meal preferences (DB only).
 * Optional query param: menuId — when provided, loads the customer's selections
 * for that specific menu from MenuSelectionRecord (historical). Falls back to
 * customer.selectedMeals when no MenuSelectionRecord exists yet (e.g. old data).
 */
router.get('/customers/:customerId/meal-profile', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { email, menuId } = req.query;

    // normalize incoming email values
    const resolvedEmail = String(email || (customerId.includes('@') ? customerId : '')).trim();

    console.log('=== GET meal-profile called ===');
    console.log('customerId:', customerId);
    console.log('email from query:', email);
    console.log('menuId from query:', menuId);

    // Try to get from cache first (30 minute TTL for profiles)
    // Include menuId in cache key so per-menu loads are cached separately
    const cacheKey = `customer:profile:${customerId}:${resolvedEmail}:${menuId || ''}`;
    // Only use cache when a specific menuId is requested (historical menu selections).
    // For plain profile views (no menuId), always read from DB so edits are reflected immediately.
    if (menuId) {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return res.json({
          success: true,
          data: cached,
          cached: true
        });
      }
    }

    // Strict, exact match only — internal Customer Management data (email or
    // customerId), nothing else. This deliberately does NOT fall back to
    // guessing via a Matter API lookup + phone/name matching: that fallback
    // used to silently attach a customer to a DIFFERENT internal record
    // (whoever's phone/name happened to match), which is exactly the kind of
    // wrong-identity/duplicate-record problem this app has repeatedly hit.
    // Used by the internal admin Customers page (with or without an email —
    // customerId alone is a valid lookup here). The customer-FACING
    // menu-selection sign-in uses the separate /subscription-profile route
    // below instead, which resolves identity straight from Matter.
    let customer = null;
    let matchedBy = resolvedEmail ? 'email' : null;
    if (resolvedEmail) {
      customer = await Customer.findOne({ email: buildEmailRegex(resolvedEmail) });
    }

    if (!customer) {
      customer = await Customer.findOne({ customerId });
      if (customer) matchedBy = 'customerId';
    }

    console.log('Customer found in DB:', customer ? 'YES' : 'NO');

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found in database.'
      });
    }

    if (customer.partner) {
      await customer.populate('partner', 'businessName businessType menuSelectionEnabled');
    }

    // Determine which selections to return.
    // If menuId is provided, prefer the MenuSelectionRecord for that specific menu
    // so customers loading an older link see their historical selections for that menu.
    let consolidatedMeals = [];
    // True only when we found a real MenuSelectionRecord for this specific menu.
    // The frontend uses this to decide whether to skip straight to the "All Set" page.
    let foundMenuSelectionRecord = false;

    if (menuId && resolvedEmail) {
      const record = await MenuSelectionRecord.findOne({
        weeklyMenuId: menuId,
        email: buildEmailRegex(resolvedEmail)
      });
      // Kitchen-side auto-assigned meals (isAutoAssigned) live in the same
      // array as customer-picked ones, but must never appear in the
      // customer-facing preview/confirmation — only the Kitchen List should
      // see them. So they're excluded here before anything is returned.
      const manuallySelectedMeals = (record?.selectedMeals || []).filter((m) => !m.isAutoAssigned);

      if (record && manuallySelectedMeals.length > 0) {
        foundMenuSelectionRecord = true;
        consolidatedMeals = manuallySelectedMeals.map(m => ({
          date: m.date,
          mealType: m.mealType,
          menuItemId: m.menuItemId,
          mealName: m.mealName,
          description: m.description,
          slotNumber: m.slotNumber,
          proteinChoice: m.proteinChoice,
          vegChoice: m.vegChoice,
          carbChoice: m.carbChoice,
          sauceChoice: m.sauceChoice,
          quantity: m.quantity || 1
        }));
        console.log('Loaded', consolidatedMeals.length, 'selections from MenuSelectionRecord for menu', menuId);
      }
    }

    // Fall back to customer.selectedMeals only when no MenuSelectionRecord was found.
    // These meals may belong to a DIFFERENT menu — the frontend will check currentWeekMenu
    // to decide whether they apply to the current link.
    if (consolidatedMeals.length === 0) {
      let rawMeals = customer.selectedMeals || [];
      if (rawMeals.length > 0) {
        const consolidatedMap = new Map();
        rawMeals.forEach(meal => {
          const dateKey = meal.date ? meal.date.toISOString().split('T')[0] : '';
          const itemId = String(meal.menuItemId || '');
          const slotKey = Number(meal.slotNumber || 0);
          const mealNameKey = String(meal.mealName || '');
          const key = `${dateKey}-${itemId}-${slotKey}-${mealNameKey}`;
          if (consolidatedMap.has(key)) {
            const existing = consolidatedMap.get(key);
            existing.quantity = (existing.quantity || 1) + (meal.quantity || 1);
          } else {
            consolidatedMap.set(key, {
              date: meal.date,
              mealType: meal.mealType,
              menuItemId: meal.menuItemId,
              mealName: meal.mealName,
              description: meal.description,
              slotNumber: meal.slotNumber,
              proteinChoice: meal.proteinChoice,
              vegChoice: meal.vegChoice,
              carbChoice: meal.carbChoice,
              sauceChoice: meal.sauceChoice,
              quantity: meal.quantity || 1
            });
          }
        });
        consolidatedMeals = Array.from(consolidatedMap.values());

        // Save consolidated meals back to database if they changed
        if (consolidatedMeals.length !== customer.selectedMeals.length) {
          customer.selectedMeals = consolidatedMeals;
          await customer.save();
        }
      }
    }

    const returnData = {
      customerId: customer.customerId,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      partner: customer.partner || null,
      mealPerDay: customer.mealPerDay,
      // Menu-selection Partner members (Partner.menuSelectionEnabled) have no
      // daily meal cap — the client bypasses the mealPerDay gate when this is set.
      unlimitedMeals: !!customer.unlimitedMeals,
      breakfastInclude: customer.breakfastInclude,
      mealSnack: customer.mealSnack,
      snackCount: customer.snackCount || 0,
      mealPlan: customer.mealPlan,
      mealExclusion: customer.mealExclusion,
      allergies: customer.allergies || [],
      athleatId: customer.athleatId,
      athleatSyncedAt: customer.athleatSyncedAt,
      selectedMeals: consolidatedMeals,
      macros: customer.macros || { C: 0, P: 0, F: 0 },
      // currentWeekMenu reflects what the customer last submitted regardless of menu
      currentWeekMenu: customer.currentWeekMenu,
      // hasSubmittedForRequestedMenu = true ONLY when a real MenuSelectionRecord was found
      // for the requested menuId. Never true from the customer.selectedMeals fallback.
      hasSubmittedForRequestedMenu: foundMenuSelectionRecord,
      lastMenuSelectionDate: customer.lastMenuSelectionDate,
      weekend: customer.weekend || false,
      hasFileMakerPreferences: !!(customer.mealPerDay > 1 || customer.mealPlan),
      matchedBy,
      note: null
    };

    // Only cache when a specific menuId was requested (historical selections).
    // Plain profile views skip caching so edits are always reflected on refresh.
    if (menuId) {
      await cacheSet(cacheKey, returnData, 300); // 5 min TTL
    }

    return res.json({
      success: true,
      data: returnData
    });
  } catch (error) {
    console.error('Error in GET meal-profile:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/menus/customers/:email/subscription-profile
 *
 * The customer-facing menu-selection sign-in (MenuSelectionLink.jsx /
 * MenuSelection.jsx) — separate from GET /meal-profile above, which is
 * shared with the internal admin Customers page and must keep working off
 * internal Customer Management data with or without an email.
 *
 * Identity/plan data (meal frequency, breakfast include, snack count, plan
 * name, macros) is resolved straight from Matter by an EXACT email lookup —
 * never internal Customer matching, and never a fuzzy phone/name fallback.
 * If the typed email has no Matter subscription, this returns a clear error
 * instead of guessing. Owner (2026-10-21): allergies alone come from the
 * linked internal Customer allergy profile. Identity, entitlements and
 * dietary exclusions remain Matter-owned.
 */
router.get('/customers/:email/subscription-profile', async (req, res) => {
  try {
    const resolvedEmail = String(req.query.email || req.params.email || '').trim();
    const { menuId } = req.query;

    if (!resolvedEmail) {
      return res.status(400).json({ success: false, message: 'An email is required.' });
    }

    let nutrition;
    try {
      nutrition = await matterApiService.getKitchenNutrition({ email: resolvedEmail });
    } catch (matterError) {
      console.error('subscription-profile: Matter API lookup failed for', resolvedEmail, '-', matterError.message);
      return res.status(matterError.statusCode || 502).json({
        success: false,
        message: matterError.statusCode === 409 ? matterError.message : 'Unable to reach the subscription service right now. Please try again shortly.'
      });
    }

    if (!nutrition) {
      return res.status(404).json({
        success: false,
        message: 'We could not find an account under this email. Kindly contact customer service.'
      });
    }

    const identity = matterSelectionIdentity(nutrition);
    const allergyProfile = await resolveMenuAllergyProfile(nutrition);
    const record = menuId ? await MenuSelectionRecord.findOne(matterSelectionFilter(menuId, nutrition)).lean() : null;
    const consolidatedMeals = record?.selectedMeals || [];
    const savedSkippedDays = (record?.skippedDays || []).filter(day => !day.resumedAt);
    const foundMenuSelectionRecord = !!record;
    const matterMacros = nutrition.macros
      ? { C: nutrition.macros.carbohydrates || 0, P: nutrition.macros.protein || 0, F: nutrition.macros.fat || 0 }
      : { C: 0, P: 0, F: 0 };
    const [matterFirstName, ...matterLastNameParts] = String(nutrition.customer_name || '').trim().split(/\s+/).filter(Boolean);

    return res.json({
      success: true,
      data: {
        ...identity,
        email: identity.matterEmail,
        phone: nutrition.phone ?? null,
        subscriptionId: identity.matterSubscriptionId,
        mealPerDay: nutrition.meal_frequency ?? null,
        unlimitedMeals: false,
        breakfastInclude: nutrition.breakfast_included ?? null,
        mealSnack: (nutrition.snacks_per_day ?? 0) > 0,
        snackCount: nutrition.snacks_per_day ?? null,
        mealPlan: nutrition.plan_name ?? null,
        deliveryDates: nutrition.active_delivery_dates,
        cycleEndDate: nutrition.cycle_end_date,
        mealExclusion: (nutrition.exclusions || []).join(', '),
        ...allergyProfile,
        partner: null,
        selectedMeals: consolidatedMeals,
        skippedDays: savedSkippedDays,
        macros: matterMacros,
        currentWeekMenu: record ? menuId : null,
        hasSubmittedForRequestedMenu: foundMenuSelectionRecord,
        lastMenuSelectionDate: record?.submittedAt || null,
        weekend: nutrition.weekend_enabled ?? false,
      }
    });
  } catch (error) {
    console.error('Error in GET subscription-profile:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/customers/:customerId/filemaker-layouts
 * Fetch raw FileMaker layout data for a customer (Customer, Leads, Orders)
 */
router.get('/customers/:customerId/filemaker-layouts', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { email } = req.query;

    const customer = await Customer.findOne({ customerId });
    const resolvedEmail = String(email || customer?.email || '').trim();

    if (!resolvedEmail) {
      return res.status(400).json({
        success: false,
        message: 'Email is required to fetch FileMaker layouts.'
      });
    }

    const parseFilemakerDate = (value) => {
      if (!value) return null;

      const raw = String(value).trim();
      if (!raw) return null;

      const direct = new Date(raw);
      if (!Number.isNaN(direct.getTime())) return direct;

      const mdY = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mdY) {
        const month = Number(mdY[1]);
        const day = Number(mdY[2]);
        const year = Number(mdY[3]);
        const parsed = new Date(year, month - 1, day);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }

      return null;
    };

    const formatAsFilemakerDate = (date) => {
      const month = String(date.getMonth() + 1);
      const day = String(date.getDate());
      const year = String(date.getFullYear());
      return `${month}/${day}/${year}`;
    };

    const [customerLayout, leadLayout, orderLayout] = await Promise.all([
      athleatService.getCustomerRawByEmail(resolvedEmail),
      athleatService.getLeadRawByEmail(resolvedEmail),
      athleatService.getOrderRawByEmail(resolvedEmail)
    ]);

    const primaryCustomer = customerLayout[0] || null;
    const uuidCustomer = primaryCustomer?.fieldData?.uuid || '';

    const orderScheduleLayout = uuidCustomer
      ? await athleatService.getOrderScheduleRawByUUID(uuidCustomer)
      : [];

    const candidateDates = [];
    orderLayout.forEach((record) => {
      const fieldData = record?.fieldData || {};
      candidateDates.push(parseFilemakerDate(fieldData.dateStart));
      candidateDates.push(parseFilemakerDate(fieldData.dateEnd));
    });
    orderScheduleLayout.forEach((record) => {
      const fieldData = record?.fieldData || {};
      candidateDates.push(parseFilemakerDate(fieldData.date));
    });

    const validDates = candidateDates.filter(Boolean);
    let menuItemLayout = [];
    if (validDates.length > 0) {
      validDates.sort((a, b) => a.getTime() - b.getTime());
      const minDate = formatAsFilemakerDate(validDates[0]);
      const maxDate = formatAsFilemakerDate(validDates[validDates.length - 1]);
      menuItemLayout = await athleatService.getMenuItemsRaw(minDate, maxDate);
    }

    return res.json({
      success: true,
      data: {
        readOnly: true,
        note: 'Preview only. No customer/profile/FileMaker records are updated by this endpoint.',
        email: resolvedEmail,
        customerLayout,
        leadLayout,
        orderLayout,
        orderScheduleLayout,
        menuItemLayout,
        summary: {
          customerCount: customerLayout.length,
          leadCount: leadLayout.length,
          orderCount: orderLayout.length,
          orderScheduleCount: orderScheduleLayout.length,
          menuItemCount: menuItemLayout.length,
          uuidCustomer: uuidCustomer || null
        }
      }
    });
  } catch (error) {
    console.error('Error fetching FileMaker layouts:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch FileMaker layouts',
      error: error.message
    });
  }
});

/**
 * POST /api/customers/:customerId/meal-profile
 * Update customer meal preferences
 */
router.post('/customers/:customerId/meal-profile', async (req, res) => {
  try {
    const { customerId } = req.params;
    const {
      email,
      mealPerDay,
      breakfastInclude,
      mealSnack,
      snackCount,
      mealPlan,
      mealExclusion,
      allergies,
      dietaryRestrictions,
      preferences,
      partner,
      unlimitedMeals,
      macros
    } = req.body;

    const updateFields = {};
    if (email !== undefined && email) updateFields.email = email;
    if (mealPerDay !== undefined) updateFields.mealPerDay = Number(mealPerDay);
    if (breakfastInclude !== undefined) updateFields.breakfastInclude = breakfastInclude;
    if (mealSnack !== undefined) updateFields.mealSnack = mealSnack;
    if (snackCount !== undefined) updateFields.snackCount = Number(snackCount) || 0;
    if (req.body.weekend !== undefined) updateFields.weekend = !!req.body.weekend;
    if (mealPlan !== undefined) updateFields.mealPlan = mealPlan;
    if (mealExclusion !== undefined) updateFields.mealExclusion = mealExclusion;
    if (allergies !== undefined) updateFields.allergies = allergies;
    if (dietaryRestrictions !== undefined) updateFields.dietaryRestrictions = dietaryRestrictions;
    if (preferences !== undefined) updateFields.preferences = preferences;
    if (macros !== undefined) updateFields.macros = macros;

    // Links/unlinks this customer to a B2B Partner whose members order via
    // Menu Selection — linking to a menuSelectionEnabled partner auto-applies
    // its preset macros and lifts the daily meal cap unless explicitly overridden.
    if (partner === '' || partner === null) {
      updateFields.partner = null;
    } else if (partner) {
      const linkedPartner = await Partner.findById(partner).select('menuSelectionEnabled presetMacros');
      if (!linkedPartner) {
        return res.status(400).json({ success: false, message: 'Partner not found' });
      }
      updateFields.partner = partner;
      if (linkedPartner.menuSelectionEnabled) {
        if (unlimitedMeals === undefined) updateFields.unlimitedMeals = true;
        if (macros === undefined) updateFields.macros = linkedPartner.presetMacros;
      }
    }
    if (unlimitedMeals !== undefined) updateFields.unlimitedMeals = !!unlimitedMeals;

    // findOneAndUpdate is atomic and avoids stale-read race conditions
    const customer = await Customer.findOneAndUpdate(
      { customerId },
      { $set: updateFields },
      { new: true, upsert: true, runValidators: true }
    );

    // Invalidate ALL possible cache key variants for this customer
    const emailVal = customer.email || '';
    const keysToDelete = [
      `customer:profile:${customerId}::`,
      `customer:profile:${customerId}:${emailVal}:`,
      `customer:profile:${emailVal}:${emailVal}:`,
    ];
    await Promise.all([
      cacheDeletePattern(`customer:profile:${customerId}:*`),
      // Also clear email-keyed entries (used when customer accesses via share link with email)
      cacheDeletePattern(`customer:profile:${emailVal}:*`),
      ...keysToDelete.map(k => cacheDelete(k).catch(() => {}))
    ]);

    res.json({
      success: true,
      message: 'Meal profile updated successfully',
      data: customer
    });
  } catch (error) {
    console.error('Error updating meal profile:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/customers/:customerId/complete-profile
 * Fetch COMPLETE customer profile (DB only)
 */
router.get('/customers/:customerId/complete-profile', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { email } = req.query;

    console.log('\n=== GET complete-profile called ===');
    console.log('customerId:', customerId);
    console.log('email:', email);

    let customer = await Customer.findOne({ customerId });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const emailToUse = email || customer.email;
    if (!emailToUse) {
      return res.json({
        customer: {
          customerId: customer.customerId,
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          phone: customer.phone
        },
        filemaked: null,
        note: 'No email found for this customer. Cannot fetch FileMaker profile.'
      });
    }

    return res.json({
      customer: {
        customerId: customer.customerId,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        athleatId: customer.athleatId,
        athleatSyncedAt: customer.athleatSyncedAt,
        uuid: customer.uuid
      },
      filemakeData: null,
      note: 'External FileMaker/Athleat API is disabled. Returning database profile only.'
    });
  } catch (error) {
    console.error('Error fetching complete profile:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/customers/:customerId/filemaker-raw
 * Fetch raw data placeholder (external API disabled)
 */
router.get('/customers/:customerId/filemaker-raw', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { email, startDate, endDate } = req.query;

    console.log('\n=== GET filemaker-raw called ===');
    console.log('customerId:', customerId);
    console.log('email:', email);

    const customer = await Customer.findOne({ customerId });
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    console.log('Customer found. email in DB:', customer.email);
    const emailToUse = email || customer.email;
    console.log('emailToUse:', emailToUse);
    
    if (!emailToUse) {
      return res.json({
        customer: {
          customerId: customer.customerId,
          email: customer.email
        },
        raw: null,
        note: 'No email found for this customer. Cannot fetch FileMaker data.'
      });
    }

    const uuidCustomer = customer.uuid || '';

    let startDateStr = startDate;
    let endDateStr = endDate;
    if (!startDateStr || !endDateStr) {
      const today = new Date();
      const end = new Date(today);
      end.setDate(end.getDate() + 30);
      startDateStr = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
      endDateStr = `${end.getMonth() + 1}/${end.getDate()}/${end.getFullYear()}`;
    }

    return res.json({
      customer: {
        customerId: customer.customerId,
        email: customer.email,
        uuid: uuidCustomer
      },
      dateRange: {
        startDate: startDateStr,
        endDate: endDateStr
      },
      raw: {
        customer: [],
        lead: [],
        order: [],
        schedule: []
      },
      note: 'External FileMaker/Athleat API is disabled.'
    });
  } catch (error) {
    console.error('Error fetching raw FileMaker data:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEEKLY MENU ROUTES
// ============================================

/**
 * GET /api/menus
 * Get all weekly menus (admin only)
 */
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 10, isActive = 'true' } = req.query;

    const query = {};
    if (isActive !== 'all') {
      query.isActive = isActive === 'true' || isActive === true;
    }

    const menus = await WeeklyMenu.find(query)
      .populate('createdBy', 'profile.firstName profile.lastName')
      .sort({ startDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await WeeklyMenu.countDocuments(query);

    // Real per-day customer selection counts (quantity-aware), for the list
    // card's day strip. Client does the local-date bucketing (same pattern
    // as the existing per-day meal-item counts) to avoid server/browser
    // timezone mismatches, so we just hand over raw {date, count} pairs.
    const menuIds = menus.map((m) => m._id);
    const selectionAgg = menuIds.length > 0
      ? await MenuSelectionRecord.aggregate([
          { $match: { weeklyMenuId: { $in: menuIds } } },
          { $unwind: '$selectedMeals' },
          { $match: { 'selectedMeals.date': { $ne: null } } },
          {
            $group: {
              _id: { menuId: '$weeklyMenuId', date: '$selectedMeals.date' },
              count: { $sum: { $ifNull: ['$selectedMeals.quantity', 1] } }
            }
          }
        ])
      : [];
    const selectionsByMenuId = new Map();
    selectionAgg.forEach((row) => {
      const key = String(row._id.menuId);
      const list = selectionsByMenuId.get(key) || [];
      list.push({ date: row._id.date, count: row.count });
      selectionsByMenuId.set(key, list);
    });

    const menusWithSelections = menus.map((m) => ({
      ...m.toObject(),
      selectionsByDate: selectionsByMenuId.get(String(m._id)) || []
    }));

    res.json({
      success: true,
      data: menusWithSelections,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching menus:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/menus/kitchen-list
 * Returns the active menu list for the kitchen list page.
 */
router.get('/kitchen-list', protect, async (req, res) => {
  try {
    const menus = await WeeklyMenu.find({ isActive: true })
      .select('title name startDate endDate selectionCount breakfastPreset breakfastMacros breakfastPresetsByName')
      .sort({ startDate: -1 })
      .lean();

    return res.json({
      success: true,
      data: menus.map((menu) => ({
        ...menu,
        breakfastPreset: parseKitchenBreakfastPreset(menu),
        breakfastPresetsByName: parseKitchenBreakfastPresetsByName(menu)
      }))
    });
  } catch (error) {
    console.error('Error fetching kitchen list menus:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/menus/kitchen-breakfast-presets
 * Returns the global kitchen breakfast presets shared across all menus.
 */
router.get('/kitchen-breakfast-presets', protect, async (req, res) => {
  try {
    const doc = await KitchenBreakfastPreset.findOne({ key: 'global' }).lean();

    return res.json({
      success: true,
      data: {
        breakfastPreset: parseKitchenBreakfastPreset(doc || {}),
        presetsByName: parseKitchenBreakfastPresetsByName({ breakfastPresetsByName: doc?.presetsByName })
      }
    });
  } catch (error) {
    console.error('Error fetching global breakfast presets:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * PUT /api/menus/kitchen-breakfast-presets
 * Saves the global kitchen breakfast presets shared across all menus.
 */
router.put('/kitchen-breakfast-presets', protect, async (req, res) => {
  try {
    const { presets = [], defaultPreset = null } = req.body || {};

    if (!Array.isArray(presets)) {
      return res.status(400).json({
        success: false,
        message: 'presets must be an array'
      });
    }

    const normalizedMap = presets.reduce((acc, row) => {
      const normalized = normalizeBreakfastPresetEntry(row || {});
      const key = normalizeBreakfastKey(normalized.breakfastName || row?.name || '');
      if (!key) return acc;
      acc[key] = normalized;
      return acc;
    }, {});

    const mapEntries = Object.values(normalizedMap);
    const resolvedDefault = normalizeBreakfastPresetEntry(defaultPreset || mapEntries[0] || {});

    const doc = await KitchenBreakfastPreset.findOneAndUpdate(
      { key: 'global' },
      {
        $set: {
          breakfastPreset: resolvedDefault,
          presetsByName: normalizedMap
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({
      success: true,
      data: {
        breakfastPreset: parseKitchenBreakfastPreset(doc || {}),
        presetsByName: parseKitchenBreakfastPresetsByName({ breakfastPresetsByName: doc?.presetsByName })
      }
    });
  } catch (error) {
    console.error('Error saving global breakfast presets:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/menus/kitchen-snack-presets
 * Returns the global, name-keyed snack macro table shared across all menus
 * and dates (see KitchenSnackPreset). Used as a fallback at calc time when a
 * snack's name matches an entry here — see calculateKitchenListEntry.
 */
router.get('/kitchen-snack-presets', protect, async (req, res) => {
  try {
    const doc = await KitchenSnackPreset.findOne({ key: 'global' }).lean();
    return res.json({
      success: true,
      data: { presetsByName: parseKitchenSnackPresetsByName(doc || {}) }
    });
  } catch (error) {
    console.error('Error fetching global snack presets:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * PUT /api/menus/kitchen-snack-presets
 * Saves individual global snack entries without replacing unrelated presets.
 * Body: { presets: [{ snackName, C, P, F }, ...], removeKeys?: [name, ...] }
 */
const saveKitchenSnackPresets = async (req, res) => {
  try {
    const update = snackPresetUpdate(req.body || {});

    const doc = await KitchenSnackPreset.findOneAndUpdate(
      { key: 'global' },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: false }
    ).lean();

    return res.json({
      success: true,
      data: { presetsByName: parseKitchenSnackPresetsByName(doc || {}) }
    });
  } catch (error) {
    console.error('Error saving global snack presets:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message
    });
  }
};
router.put('/kitchen-snack-presets', protect, saveKitchenSnackPresets);
router.patch('/kitchen-snack-presets', protect, saveKitchenSnackPresets);

/**
 * GET /api/menus/:id/breakfast-presets
 * Returns imported breakfast presets for a menu.
 */
router.get('/:id/breakfast-presets', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const menu = await WeeklyMenu.findById(id)
      .select('breakfastPreset breakfastMacros breakfastPresetsByName')
      .lean();

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: 'Menu not found'
      });
    }

    return res.json({
      success: true,
      data: {
        breakfastPreset: parseKitchenBreakfastPreset(menu),
        presetsByName: parseKitchenBreakfastPresetsByName(menu)
      }
    });
  } catch (error) {
    console.error('Error fetching breakfast presets:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * PUT /api/menus/:id/breakfast-presets
 * Saves imported breakfast presets for a menu.
 */
router.put('/:id/breakfast-presets', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const { presets = [], defaultPreset = null } = req.body || {};

    if (!Array.isArray(presets)) {
      return res.status(400).json({
        success: false,
        message: 'presets must be an array'
      });
    }

    const normalizedMap = presets.reduce((acc, row) => {
      const normalized = normalizeBreakfastPresetEntry(row || {});
      const key = normalizeBreakfastKey(normalized.breakfastName || row?.name || '');
      if (!key) return acc;
      acc[key] = normalized;
      return acc;
    }, {});

    const mapEntries = Object.values(normalizedMap);
    const resolvedDefault = normalizeBreakfastPresetEntry(
      defaultPreset || mapEntries[0] || {}
    );

    const menu = await WeeklyMenu.findByIdAndUpdate(
      id,
      {
        $set: {
          breakfastPreset: resolvedDefault,
          breakfastPresetsByName: normalizedMap
        }
      },
      { new: true }
    )
      .select('breakfastPreset breakfastPresetsByName')
      .lean();

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: 'Menu not found'
      });
    }

    return res.json({
      success: true,
      data: {
        breakfastPreset: parseKitchenBreakfastPreset(menu),
        presetsByName: parseKitchenBreakfastPresetsByName(menu)
      }
    });
  } catch (error) {
    console.error('Error saving breakfast presets:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

const toDateKey = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

// Owner (2026-10-09): one person must never end up with two selection records
// for the same menu. A person can have two Customer profiles (the internal one,
// linked to their Matter subscription, and one under their Matter email); an
// assignment aimed at the Matter email while the linked profile's record already
// exists used to upsert a SECOND record, so their meals were cooked and counted
// twice. Before assigning, point such a target at the email the person's
// existing record is saved under (found through the Matter subscription id).
const canonicalizeAssignCustomers = async (menuId, customers, matterInputs = []) => {
  if (!Array.isArray(customers) || !customers.length) return customers;
  const records = await MenuSelectionRecord.find({ weeklyMenuId: menuId }).select('email matterEmail matterCustomerId matterSubscriptionId').lean();
  return mapWithConcurrency(customers, 8, async (target) => {
    const record = records.find((record) => normalizeMatterEmail(record.email) === normalizeMatterEmail(target.email));
    const permanentId = target.matterCustomerId || record?.matterCustomerId;
    const source = matterInputs.find((input) => permanentId
      ? String(input.customer_id) === String(permanentId)
      : normalizeMatterEmail(input.customer_email) === normalizeMatterEmail(record?.matterEmail || target.email));
    const nutrition = source || await matterApiService.getKitchenNutrition({
      customerId: permanentId, email: record?.matterEmail || target.email,
      subscriptionId: record?.matterSubscriptionId || target.subscriptionId,
    });
    const identity = matterSelectionIdentity(nutrition);
    if (!Number.isInteger(Number(nutrition.meal_frequency)) || Number(nutrition.meal_frequency) < 1
      || typeof nutrition.breakfast_included !== 'boolean' || nutrition.snacks_per_day == null
      || !Number.isInteger(Number(nutrition.snacks_per_day)) || Number(nutrition.snacks_per_day) < 0
      || !Array.isArray(nutrition.exclusions)) throw new Error('Matter meal entitlements or exclusions are unresolved. Retry after checking Matter.');
    const existing = records.find((entry) => String(entry.matterCustomerId || '') === identity.matterCustomerId)
      || record;
    return { ...target, email: existing?.email || identity.matterEmail, ...identity,
      name: nutrition.customer_name, subscriptionId: identity.matterSubscriptionId,
      mealFrequency: nutrition.meal_frequency, breakfastIncluded: nutrition.breakfast_included,
      exclusions: nutrition.exclusions || [], nutrition,
    };
  });
};

// Owner (2026-10-09): the weekly menu file (Menu Management upload — MEAL TYPE,
// INTOLERANCES, DAY, MEAL NAME, SLOT, PROTEIN TYPE) is the single source for the
// rotation. Where a date has no hand-built rotation saved on the menu itself
// (mainMealOptionsByDate / breakfastOptionsByDate), the Kitchen List reads the
// rotation straight from that day's MenuItems instead: main/sub by SLOT with
// PROTEIN TYPE, breakfast by name. Anything saved on the menu wins.
const splitIntolerances = (value) => String(value || '').split(/[,;|\n\r]/).map((s) => s.trim()).filter(Boolean);
const getMenuItemRotationByDate = async (menuDoc) => {
  const ids = (menuDoc?.meals || []).flatMap((m) => m.items || []);
  if (ids.length === 0) return {};
  const items = await MenuItem.find({ _id: { $in: ids } })
    .select('mealName mealType itemDate rotationCategory portionType intolerances')
    .lean();
  const byId = new Map(items.map((i) => [String(i._id), i]));
  const out = {};
  ids.forEach((id) => {
    const item = byId.get(String(id));
    const dateKey = item ? toDateKey(item.itemDate) : null;
    if (!dateKey) return;
    if (!out[dateKey]) out[dateKey] = { mainMeals: [], subMeals: [], breakfast: [] };
    const option = { name: item.mealName, type: item.portionType || '', exclusions: splitIntolerances(item.intolerances) };
    if (item.mealType === 'main' && item.rotationCategory === 'main') out[dateKey].mainMeals.push(option);
    else if (item.mealType === 'main' && item.rotationCategory === 'sub') out[dateKey].subMeals.push(option);
    else if (item.mealType === 'breakfast') out[dateKey].breakfast.push({ name: item.mealName, exclusions: option.exclusions });
  });
  return out;
};

// A legacy record's value may still be a plain array (before the first/second
// split) — treat it as the "first" pool so old data keeps working.
const normalizeSnackPools = (value) => {
  if (Array.isArray(value)) return { first: value, second: [] };
  return { first: value?.first || [], second: value?.second || [] };
};

// Owner (2026-10-06): snacks uploaded with a menu are added to that day's snack
// pool, so the kitchen's snack auto-assign can draw them. Additive only: options
// already in the pool keep their kitchen-set macros and exclusions, and a name
// already present is not duplicated. New names go to whichever of first/second is
// smaller, so the slot alternation stays balanced. Uploaded snacks carry no
// macros, so they start at 0 until the kitchen sets them. The item's
// INTOLERANCES are used as the snack's exclusions.
const mergeUploadedSnackPools = (menu, days) => {
  for (const day of days) {
    const dateKey = toDateKey(day?.date);
    if (!dateKey || !Array.isArray(day.items)) continue;

    const uploaded = day.items.filter((item) => item?.mealType === 'snack' && String(item.mealName || '').trim());
    if (uploaded.length === 0) continue;

    const current = normalizeSnackPools(menu.snackOptionsByDate.get(dateKey));
    const first = [...current.first];
    const second = [...current.second];
    const known = new Set([...first, ...second].map((opt) => String(opt.name).trim().toLowerCase()));

    for (const item of uploaded) {
      const name = String(item.mealName).trim();
      if (known.has(name.toLowerCase())) continue;
      known.add(name.toLowerCase());
      const exclusions = String(item.intolerances || '').split(/[,;|]/).map((e) => e.trim()).filter(Boolean);
      (first.length <= second.length ? first : second).push({ name, exclusions, C: 0, P: 0, F: 0 });
    }

    menu.snackOptionsByDate.set(dateKey, { first, second });
  }
};

/**
 * GET /api/menus/:id/snack-options
 * Returns the kitchen-defined snack ingredient options, keyed by date, each
 * split into a "first" and "second" pool.
 */
router.get('/:id/snack-options', protect, async (req, res) => {
  try {
    const menu = await WeeklyMenu.findById(req.params.id).select('snackOptionsByDate').lean();
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    const optionsByDate = {};
    for (const [date, value] of Object.entries(menu.snackOptionsByDate || {})) {
      optionsByDate[date] = normalizeSnackPools(value);
    }

    res.json({ success: true, data: optionsByDate });
  } catch (error) {
    console.error('Error fetching snack options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/menus/:id/snack-options
 * Replaces the "first" and "second" snack pools for one date, OR — when
 * `entries` is given — for many dates at once in a single save (see
 * main-meal-options above for why: the weekly upload used to PUT once per date).
 * Body: { date: 'YYYY-MM-DD', first: [{ name, exclusions, C, P, F }], second: [...] }
 *   or: { entries: [{ date, first, second }, ...] }
 */
router.put('/:id/snack-options', protect, async (req, res) => {
  try {
    const { date, first, second, entries } = req.body || {};

    const normalizePool = (list) => (Array.isArray(list) ? list : [])
      .map((opt) => ({
        name: String(opt?.name || '').trim(),
        exclusions: Array.isArray(opt?.exclusions)
          ? opt.exclusions.map((e) => String(e).trim()).filter(Boolean)
          : String(opt?.exclusions || '').split(',').map((e) => e.trim()).filter(Boolean),
        C: Number(opt?.C) || 0,
        P: Number(opt?.P) || 0,
        F: Number(opt?.F) || 0
      }))
      .filter((opt) => opt.name);

    const menu = await WeeklyMenu.findById(req.params.id);
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    if (Array.isArray(entries) && entries.length > 0) {
      let appliedAny = false;
      for (const entry of entries) {
        const dateKey = toDateKey(entry?.date);
        if (!dateKey) continue;
        menu.snackOptionsByDate.set(dateKey, {
          first: normalizePool(entry?.first),
          second: normalizePool(entry?.second)
        });
        appliedAny = true;
      }
      if (!appliedAny) {
        return res.status(400).json({ success: false, message: 'No entry had a valid date' });
      }
    } else {
      const dateKey = toDateKey(date);
      if (!dateKey) {
        return res.status(400).json({ success: false, message: 'A valid date is required' });
      }
      menu.snackOptionsByDate.set(dateKey, {
        first: normalizePool(first),
        second: normalizePool(second)
      });
    }

    await menu.save();

    const optionsByDate = {};
    for (const [key, value] of menu.snackOptionsByDate.entries()) {
      optionsByDate[key] = normalizeSnackPools(value);
    }

    res.json({ success: true, data: optionsByDate });
  } catch (error) {
    console.error('Error saving snack options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/menus/:id/breakfast-options
 * Returns the kitchen-defined per-date breakfast rotation (name + exclusions).
 * Macros are resolved separately by name against breakfastPresetsByName.
 */
router.get('/:id/breakfast-options', protect, async (req, res) => {
  try {
    const menu = await WeeklyMenu.findById(req.params.id).select('breakfastOptionsByDate meals').lean();
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    const optionsByDate = {};
    for (const [date, options] of Object.entries(menu.breakfastOptionsByDate || {})) {
      optionsByDate[date] = options || [];
    }
    const derived = await getMenuItemRotationByDate(menu);
    for (const [date, value] of Object.entries(derived)) {
      if ((optionsByDate[date] || []).length === 0 && value.breakfast.length > 0) optionsByDate[date] = value.breakfast;
    }

    res.json({ success: true, data: optionsByDate });
  } catch (error) {
    console.error('Error fetching breakfast options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/menus/:id/breakfast-options
 * Replaces the breakfast rotation for one date, OR — when `entries` is
 * given — for many dates at once in a single save (see main-meal-options
 * above for why).
 * Body: { date: 'YYYY-MM-DD', options: [{ name, exclusions }] }
 *   or: { entries: [{ date, options }, ...] }
 */
router.put('/:id/breakfast-options', protect, async (req, res) => {
  try {
    const { date, options, entries } = req.body || {};

    const normalize = (list) => (Array.isArray(list) ? list : [])
      .map((opt) => ({
        name: String(opt?.name || '').trim(),
        exclusions: Array.isArray(opt?.exclusions)
          ? opt.exclusions.map((e) => String(e).trim()).filter(Boolean)
          : String(opt?.exclusions || '').split(',').map((e) => e.trim()).filter(Boolean)
      }))
      .filter((opt) => opt.name);

    const menu = await WeeklyMenu.findById(req.params.id);
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    if (Array.isArray(entries) && entries.length > 0) {
      let appliedAny = false;
      for (const entry of entries) {
        const dateKey = toDateKey(entry?.date);
        if (!dateKey) continue;
        menu.breakfastOptionsByDate.set(dateKey, normalize(entry?.options));
        appliedAny = true;
      }
      if (!appliedAny) {
        return res.status(400).json({ success: false, message: 'No entry had a valid date' });
      }
    } else {
      const dateKey = toDateKey(date);
      if (!dateKey) {
        return res.status(400).json({ success: false, message: 'A valid date is required' });
      }
      menu.breakfastOptionsByDate.set(dateKey, normalize(options));
    }

    await menu.save();

    const optionsByDate = {};
    for (const [key, opts] of menu.breakfastOptionsByDate.entries()) {
      optionsByDate[key] = opts || [];
    }

    res.json({ success: true, data: optionsByDate });
  } catch (error) {
    console.error('Error saving breakfast options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

const optionExcludedByCustomer = (option, customerExclusions) => {
  return kitchenConflictList(option, customerExclusions).length > 0;
};

/**
 * POST /api/menus/:id/assign-snacks
 * Ensures each customer's snack slots are filled for that day (from their
 * website subscription's snacks_per_day). Each date has a "first" and
 * "second" snack pool; slot 1 (and every odd slot) draws from "first", slot 2
 * (and every even slot) from "second" — so a 2-snack/day customer gets
 * exactly one from each, a 50/50 split — falling back to the other pool if
 * one has no eligible option. Each pick is random within its pool, skipping
 * any option whose exclusion tags match the customer's exclusion list.
 * Idempotent: only fills in missing slots, never duplicates existing
 * assignments. Macros for each slot are the ingredient's macros divided by
 * the day's snack count.
 *
 * Body: { date, customers: [{ email }] } — scopes to just these customers'
 * snacks for just this date (used by the unified Auto-Assign action for
 * customers missing a selection on a specific date). Omit both to fall back
 * to the old menu-wide behavior (every customer's selection record, every
 * date they have non-snack meals for).
 */
async function runAssignSnacks(menuId, { date, customers } = {}, { matterInputs = [] } = {}) {
    if (Array.isArray(customers)) customers = await canonicalizeAssignCustomers(menuId, customers, matterInputs);
    const scopedDateKey = date ? toDateKey(date) : null;
    const scopedEmails = Array.isArray(customers)
      ? new Set(customers.map((c) => String(c.email || '').trim().toLowerCase()).filter(Boolean))
      : null;

    const menu = await WeeklyMenu.findById(menuId).select('snackOptionsByDate meals selectionDeadlines').lean();
    if (!menu) {
      return { error: 'Menu not found', status: 404 };
    }
    if (scopedDateKey) assertKitchenSelectionClosed(menu, scopedDateKey);
    const snackOptionsByDate = menu.snackOptionsByDate || {};

    const allRecords = await MenuSelectionRecord.find({ weeklyMenuId: menuId });
    const records = scopedEmails
      ? allRecords.filter((r) => scopedEmails.has(String(r.email || '').trim().toLowerCase()))
      : allRecords;

    // Preflight every unscoped date before any customer or meal write.
    if (!scopedDateKey) for (const day of new Set(records.flatMap(record => (record.selectedMeals || []).filter(meal => meal.mealType !== 'snack').map(meal => toDateKey(meal.date))).filter(Boolean))) assertKitchenSelectionClosed(menu, day);

    // Nutrition lookups (2 Matter API calls each) dominate runtime — run every
    // customer concurrently instead of one at a time.
    const ingredientReads = new Map();
    const results = await mapWithConcurrency(records, 8, async (record) => {
      const stats = { assigned: 0, skippedNoSnacksNeeded: 0, skippedNoOptions: 0, datesWithNoOptions: [] };

      let nutrition = matterInputs.find((input) => record.matterCustomerId
        ? String(input.customer_id) === String(record.matterCustomerId)
        : normalizeMatterEmail(input.customer_email) === normalizeMatterEmail(record.matterEmail || record.email));
      if (!nutrition) nutrition = await matterApiService.getKitchenNutrition({ customerId: record.matterCustomerId, email: record.matterEmail || record.email, subscriptionId: record.matterSubscriptionId });

      if (!nutrition || nutrition.snacks_per_day == null || !Number.isFinite(Number(nutrition.snacks_per_day))) {
        throw new Error('Snack entitlement is unresolved. Retry kitchen preparation.');
      }
      const snacksPerDay = Number(nutrition.snacks_per_day);
      if (snacksPerDay <= 0) {
        stats.skippedNoSnacksNeeded = 1;
        return stats;
      }

      const exclusions = (nutrition.exclusions || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean);

      // Scoped runs only ever touch the one requested date — even if the
      // customer has meals on other dates already, this call has no business
      // touching those.
      const dateKeys = scopedDateKey
        ? [scopedDateKey]
        : Array.from(new Set(
            (record.selectedMeals || [])
              .filter((m) => m.mealType !== 'snack')
              .map((m) => toDateKey(m.date))
              .filter(Boolean)
          ));

      for (const dateKey of dateKeys) {
        if (await kitchenDateUnavailable(record, dateKey, nutrition)) continue;
        const newSnacks = [];
        const existingSnackCount = (record.selectedMeals || []).filter(
          (m) => m.mealType === 'snack' && toDateKey(m.date) === dateKey
        ).length;
        const existingSnackPortions = (record.selectedMeals || []).filter((meal) => meal.mealType === 'snack' && toDateKey(meal.date) === dateKey).reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
        const slotsNeeded = snacksPerDay - existingSnackPortions;
        if (slotsNeeded <= 0) continue;

        const rawPools = snackOptionsByDate[dateKey];
        const dayPools = Array.isArray(rawPools)
          ? { first: rawPools, second: [] }
          : { first: rawPools?.first || [], second: rawPools?.second || [] };
        // Share the executed Promise, not a Mongoose Query: awaiting the same
        // Query in concurrent customer workers attempts to execute it again.
        if (!ingredientReads.has(dateKey)) ingredientReads.set(dateKey, MenuItem.find({
          _id: { $in: (menu.meals || []).flatMap(day => day.items || []) }, itemDate: new Date(dateKey), mealType: 'snack',
        }).lean().exec());
        const ingredients = await ingredientReads.get(dateKey);
        const eligibleFirst = mergeKitchenMetadata(dayPools.first, ingredients).filter((opt) => !optionExcludedByCustomer(opt, exclusions));
        const eligibleSecond = mergeKitchenMetadata(dayPools.second, ingredients).filter((opt) => !optionExcludedByCustomer(opt, exclusions));

        if (eligibleFirst.length === 0 && eligibleSecond.length === 0) {
          stats.skippedNoOptions += 1;
          stats.datesWithNoOptions.push(dateKey);
          continue;
        }

        for (let i = 0; i < slotsNeeded; i += 1) {
          const overallSlotIndex = existingSnackCount + i;
          const preferFirst = overallSlotIndex % 2 === 0;
          let pool = preferFirst ? eligibleFirst : eligibleSecond;
          if (pool.length === 0) pool = preferFirst ? eligibleSecond : eligibleFirst;
          if (pool.length === 0) {
            stats.skippedNoOptions += 1;
            continue;
          }

          const choice = pool[Math.floor(Math.random() * pool.length)];
          newSnacks.push({
            date: new Date(dateKey),
            mealType: 'snack',
            mealName: choice.name,
            quantity: 1,
            snackMacros: {
              C: (Number(choice.C) || 0) / snacksPerDay,
              P: (Number(choice.P) || 0) / snacksPerDay,
              F: (Number(choice.F) || 0) / snacksPerDay
            },
            isAutoAssigned: true
          });
        }

        if (newSnacks.length === 0) continue;

        // Conditional write: only add these snacks if the record STILL has
        // the snack count for this date that we computed from. Two runs can
        // overlap (the background auto-populate job + a manual Auto-Assign,
        // or two staff tabs) — both used to read "0 snacks" and both push,
        // doubling the customer's snacks. The loser of the race now matches
        // nothing and simply skips.
        await assertAssignmentMacros(newSnacks);
        const dayStart = new Date(dateKey);
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const writeResult = await MenuSelectionRecord.updateOne(
          {
            _id: record._id,
            skippedDays: record.skippedDays || [],
            $expr: {
              $eq: [
                {
                  $size: {
                    $filter: {
                      input: { $ifNull: ['$selectedMeals', []] },
                      as: 'm',
                      cond: {
                        $and: [
                          { $eq: ['$$m.mealType', 'snack'] },
                          { $gte: ['$$m.date', dayStart] },
                          { $lt: ['$$m.date', dayEnd] }
                        ]
                      }
                    }
                  }
                },
                existingSnackCount
              ]
            }
          },
          { $push: { selectedMeals: { $each: newSnacks } } }
        );
        if (writeResult.modifiedCount > 0) stats.assigned += newSnacks.length;
      }

      return stats;
    });

    const assigned = results.reduce((sum, r) => sum + r.assigned, 0);
    const skippedNoSnacksNeeded = results.reduce((sum, r) => sum + r.skippedNoSnacksNeeded, 0);
    const skippedNoOptions = results.reduce((sum, r) => sum + r.skippedNoOptions, 0);
    const datesWithNoOptions = Array.from(new Set(results.flatMap((r) => r.datesWithNoOptions))).sort();

    return {
      data: { assigned, skippedNoSnacksNeeded, skippedNoOptions, datesWithNoOptions, customersProcessed: records.length }
    };
}

router.post('/:id/assign-snacks', protect, async (req, res) => {
  try {
    const { date, customers } = req.body || {};
    const result = await runAssignSnacks(req.params.id, { date, customers });
    if (result.error) {
      return res.status(result.status).json({ success: false, message: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (error) {
    console.error('Error assigning snacks:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, code: error.code, selectionWindow: error.selectionWindow });
  }
});

// Runs `mapper` over `items` with at most `limit` in flight at once — server-
// side equivalent of the client's kitchenData.js helper, used here so a
// Matter Core batch's per-customer nutrition lookups (for snacks_per_day)
// don't fire all at once.
const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * Matter Core plan customers skip the chicken/beef/fish type rotation and
 * exclusion filtering entirely: a customer needing N main meals just gets
 * matterCoreMealOptionsByDate[dateKey][0..N-1] in order (offset by however
 * many they already have that day), one breakfast is always the date's FIRST
 * breakfast option (never random), and snacks are always each pool's FIRST
 * item (never random) — "first meal available, second meal available."
 * Idempotent per customer, same as runAssignMainMeals/runAssignSnacks: only
 * fills the gap between what they already have and what they need.
 *
 * Breakfast does NOT reduce the main meal count here (unlike
 * runAssignMainMeals, where breakfastInclude counts as one of
 * meal_frequency's slots) — a Matter Core customer with meal_frequency 2 and
 * breakfastInclude on gets 2 main meals AND a breakfast, not 1 main meal.
 *
 * `customers` here additionally carries `subscriptionId` (the Matter
 * subscription id) so snacks_per_day can be looked up directly, and
 * `mealFrequency` from that same subscription (see runAutoPopulateMissing).
 *
 * `snackOnly` (default false): when true, main meal and breakfast filling is
 * skipped entirely — only snacks are considered. Used for customers who
 * already made their own meal selection: snacks are never customer-
 * selectable, so they're always auto-assigned regardless, but an existing
 * selection must never be touched otherwise.
 *
 * `includeBreakfast` (only meaningful with snackOnly): also fill the plan's
 * extra breakfast for a customer whose Matter plan includes one — still
 * without touching their main meals. Owner (2026-10-19): a Matter Core
 * customer with breakfast included always gets 1 breakfast on top of their
 * meals.
 */
async function runAssignMatterCoreMeals(menuId, dateKey, customers, { snackOnly = false, includeBreakfast = false, matterInputs = [] } = {}) {

  const menu = await WeeklyMenu.findById(menuId)
    .select('matterCoreMealOptionsByDate breakfastOptionsByDate snackOptionsByDate meals selectionDeadlines')
    .lean();
  if (!menu) {
    return { error: 'Menu not found', status: 404 };
  }
  assertKitchenSelectionClosed(menu, dateKey);
  customers = await canonicalizeAssignCustomers(menuId, customers, matterInputs);

  // Candidates come from that day's MenuItem records tagged usedForCorePlan
  // (set in the meal editor) rather than the older matterCoreMealOptionsByDate
  // list — same switchover as runAssignMainMeals, and the same reasoning:
  // the meal editor is now the one place a dish gets entered, so this no
  // longer needs a duplicate, hand-typed list to stay in sync with.
  const corePlanMenuItems = await MenuItem.find({
    _id: { $in: (menu.meals || []).flatMap((day) => (day.items || []).map((item) => item._id || item)) },
    itemDate: new Date(dateKey),
    mealType: 'main',
    usedForCorePlan: true
  }).lean();
  let mealList = corePlanMenuItems.map(toKitchenOption);
  // Fallback for dates that haven't been tagged in the new meal editor yet.
  if (mealList.length === 0) {
    mealList = (menu.matterCoreMealOptionsByDate || {})[dateKey] || [];
  }
  let breakfastOptions = (menu.breakfastOptionsByDate || {})[dateKey] || [];
  if (breakfastOptions.length === 0) {
    // No hand-built breakfast list for the date — use that day's breakfast
    // dishes from the menu file, in file order (the FIRST one is always used).
    const dayBreakfastItems = await MenuItem.find({ _id: { $in: (menu.meals || []).flatMap((day) => (day.items || []).map((item) => item._id || item)) }, itemDate: new Date(dateKey), mealType: 'breakfast' }).sort({ _id: 1 }).lean();
    breakfastOptions = dayBreakfastItems.map(toKitchenOption);
  }
  const rawSnackPools = (menu.snackOptionsByDate || {})[dateKey];
  const snackPools = Array.isArray(rawSnackPools)
    ? { first: rawSnackPools, second: [] }
    : { first: rawSnackPools?.first || [], second: rawSnackPools?.second || [] };

  const breakfastIncludeByEmail = new Map(customers.map((c) => [normalizeMatterEmail(c.email), c.breakfastIncluded]));

  const sortedCustomers = [...customers].sort(
    (a, b) => String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''))
  );

  // snacks_per_day lives on the Matter website subscription, not on the
  // caller-supplied customer shape — fetched here (bounded concurrency)
  // directly by subscription id, since these customers were already resolved
  // from a specific Matter subscription by the caller.
  const snacksPerDayBySubscriptionId = new Map();
  // The same Matter nutrition record carries the customer's delivery dates,
  // which decide whether this date is a Matter Core DOUBLE delivery day.
  const deliveryDatesBySubscriptionId = new Map();
  await mapWithConcurrency(
    sortedCustomers.filter((c) => c.subscriptionId),
    8,
    async (c) => {
      try {
        const nutrition = c.nutrition;
        if (!nutrition || nutrition.snacks_per_day == null || !Number.isFinite(Number(nutrition.snacks_per_day))) throw new Error('Unresolved snack entitlement');
        snacksPerDayBySubscriptionId.set(c.subscriptionId, Number(nutrition.snacks_per_day));
        deliveryDatesBySubscriptionId.set(c.subscriptionId, Array.isArray(nutrition.active_delivery_dates) ? nutrition.active_delivery_dates : null);
      } catch (err) {
        console.error(`Matter Core assignment: nutrition lookup failed for subscription ${c.subscriptionId}:`, err.message);
        throw new Error('Matter Core snack entitlement could not be verified. Retry preparation.');
      }
    }
  );

  let assignedMainMeals = 0;
  let skippedNoOption = 0;
  let assignedBreakfast = 0;
  let skippedBreakfastNoOption = 0;
  let assignedSnacks = 0;
  let skippedSnackNoOption = 0;
  let doubleDeliveryCustomers = 0;

  for (const customer of sortedCustomers) {
    const email = String(customer.email || '').trim();
    if (!email) continue;

    const existingRecord = await MenuSelectionRecord.findOne({ weeklyMenuId: menuId, email }).lean();
    if (await kitchenDateUnavailable(existingRecord, dateKey, customer.nutrition)) continue;
    const existingMainMealsCount = (existingRecord?.selectedMeals || []).filter(
      (m) => toDateKey(m.date) === dateKey && m.mealType === 'main'
    ).reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
    const hasBreakfastAlready = (existingRecord?.selectedMeals || []).some(
      (m) => toDateKey(m.date) === dateKey && m.mealType === 'breakfast'
    );
    const existingSnackCount = (existingRecord?.selectedMeals || []).filter(
      (m) => m.mealType === 'snack' && toDateKey(m.date) === dateKey
    ).length;

    // Matter subscription's own breakfast_included wins; Customer profile is fallback.
    const breakfastInclude = typeof customer.breakfastIncluded === 'boolean'
      ? customer.breakfastIncluded
      : (breakfastIncludeByEmail.get(email.toLowerCase()) || false);
    // Unlike the standard-plan assignment (runAssignMainMeals), breakfast is
    // never subtracted from the main meal count for Matter Core — it's
    // always an extra on top of the full meal_frequency, per the plan's
    // own rules.
    const mealFrequency = Math.max(1, Number(customer.mealFrequency) || 1);
    // Owner (2026-10-23): a customer delivered only Mon/Wed/Fri gets a DOUBLE
    // delivery on Monday (+Tuesday) and Wednesday (+Thursday): twice their
    // meals that day. 1 meal/day -> the date's first AND second Matter Core
    // meal (never the same meal twice); 2+ meals/day -> their usual meals
    // doubled (A, B, A, B). Friday stays single.
    const isDoubleDay = isMatterCoreDoubleDay(dateKey, deliveryDatesBySubscriptionId.get(customer.subscriptionId));
    if (isDoubleDay) doubleDeliveryCustomers += 1;
    const totalNeeded = mealFrequency * (isDoubleDay ? 2 : 1);
    const slotsNeeded = totalNeeded - existingMainMealsCount;

    const newMeals = [];

    const exclusions = customer.exclusions || [];
    const eligibleCoreMeals = mealList.filter(option => !optionExcludedByCustomer(option, exclusions));
    const coreChoices = eligibleCoreMeals.length ? eligibleCoreMeals : mealList;

    // snackOnly skips main meals — except on a double day, where the extra
    // meals are still topped up for a customer who already has the usual set.
    if ((!snackOnly || isDoubleDay) && slotsNeeded > 0) {
      for (let i = 0; i < slotsNeeded; i += 1) {
        const position = existingMainMealsCount + i;
        const chosen = (isDoubleDay && mealFrequency > 1 ? coreChoices[position % mealFrequency] : coreChoices[position])
          || coreChoices[position % coreChoices.length];
        if (!chosen) {
          skippedNoOption += 1;
          continue;
        }
        newMeals.push({
          date: new Date(dateKey),
          mealType: 'main',
          // Only MenuItem-sourced options have a real _id (the fallback
          // pool's plain {name} entries don't).
          menuItemId: chosen._id || undefined,
          mealName: chosen.name,
          quantity: 1,
          slotNumber: position,
          ...kitchenConflictFields(chosen, exclusions),
          isAutoAssigned: true
        });
        assignedMainMeals += 1;
      }
    }

    if ((!snackOnly || includeBreakfast) && breakfastInclude && !hasBreakfastAlready) {
      const choice = breakfastOptions.find(option => !optionExcludedByCustomer(option, exclusions));
      if (choice) {
        newMeals.push({
          date: new Date(dateKey),
          mealType: 'breakfast',
          mealName: choice.name,
          quantity: 1,
          isAutoAssigned: true
        });
        assignedBreakfast += 1;
      } else {
        skippedBreakfastNoOption += 1;
      }
    }

    const snacksPerDay = customer.subscriptionId
      ? (snacksPerDayBySubscriptionId.get(customer.subscriptionId) || 0)
      : 0;
    const snackSlotsNeeded = snacksPerDay - existingSnackCount;
    if (snackSlotsNeeded > 0) {
      for (let i = 0; i < snackSlotsNeeded; i += 1) {
        const overallSlotIndex = existingSnackCount + i;
        const pool = (overallSlotIndex % 2 === 0 ? snackPools.first : snackPools.second)
          .filter(option => !optionExcludedByCustomer(option, exclusions));
        const choice = pool[0];
        if (!choice) {
          skippedSnackNoOption += 1;
          continue;
        }
        newMeals.push({
          date: new Date(dateKey),
          mealType: 'snack',
          mealName: choice.name,
          quantity: 1,
          snackMacros: {
            C: (Number(choice.C) || 0) / snacksPerDay,
            P: (Number(choice.P) || 0) / snacksPerDay,
            F: (Number(choice.F) || 0) / snacksPerDay
          },
          isAutoAssigned: true
        });
        assignedSnacks += 1;
      }
    }

    if (newMeals.length === 0) continue;

    await assertAssignmentMacros(newMeals);
    await appendKitchenMeals(menuId, email, existingRecord,
      {
        $setOnInsert: {
          weeklyMenuId: menuId,
          email,
          matterCustomerId: customer.matterCustomerId,
          matterEmail: customer.matterEmail,
          matterSubscriptionId: customer.matterSubscriptionId,
          customerId: customer.customerId ? String(customer.customerId) : undefined,
          firstName: customer.name || email
        },
        $push: { selectedMeals: { $each: newMeals } }
      }
    );
  }

  return {
    data: {
      assignedMainMeals,
      skippedNoOption,
      assignedBreakfast,
      skippedBreakfastNoOption,
      assignedSnacks,
      skippedSnackNoOption,
      doubleDeliveryCustomers,
      customersProcessed: sortedCustomers.length
    }
  };
}

router.post('/:id/assign-matter-core-meals', protect, async (req, res) => {
  try {
    const { date, customers } = req.body || {};
    const dateKey = toDateKey(date);
    if (!dateKey) {
      return res.status(400).json({ success: false, message: 'A valid date is required' });
    }
    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ success: false, message: 'customers must be a non-empty array' });
    }

    const result = await runAssignMatterCoreMeals(req.params.id, dateKey, customers, { snackOnly: !!req.body?.snackOnly, includeBreakfast: !!req.body?.includeBreakfast });
    if (result.error) {
      return res.status(result.status).json({ success: false, message: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (error) {
    console.error('Error assigning Matter Core meals:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, code: error.code, selectionWindow: error.selectionWindow });
  }
});

/**
 * POST /api/menus/:id/auto-populate-missing
 * Body: { date }
 *
 * Kitchen counting should never silently miss a Matter subscriber who has a
 * delivery that day but never submitted a menu selection themselves. This
 * finds every Matter website subscription with an active delivery on `date`,
 * resolves each to an internal Customer via the same match cascade used
 * elsewhere (manual link -> email -> phone -> name — see
 * customerMatchService), and for any that still have no selection for that
 * date, runs the same main-meal/breakfast/snack assignment kitchen staff
 * already trigger manually (runAssignMainMeals/runAssignSnacks), so the
 * gap-filling logic only exists once. A customer already matched internally
 * (even under a different email) is reused, never duplicated — a new
 * Customer is only created when the full cascade finds nothing at all.
 *
 * findSubscriptionsWithDeliveryOnDate does a full-detail Matter API fetch per
 * active subscription, so the result is cached briefly per (menu, date) —
 * this is meant to run once per kitchen page load for a date, not on every
 * request.
 */
async function runAutoPopulateMissing(menuId, dateKey, options) {
  const window = await readKitchenSelectionWindow(menuId, dateKey);
  if (!window.canAutoAssign) throw Object.assign(new Error(window.message), { statusCode: 409, code: 'KITCHEN_SELECTION_OPEN', selectionWindow: window });
  return withKitchenPreparation(`menu:${menuId}:${dateKey}`, () => populateMissingKitchenSelections(menuId, dateKey, options));
}

async function populateMissingKitchenSelections(menuId, dateKey, { freshInputs = false } = {}) {
  const cacheKey = `menu:${menuId}:autoPopulated:v2:${dateKey}`;
  const cached = freshInputs ? null : await cacheGet(cacheKey);
  if (cached && !freshInputs) return { data: cached, cached: true };

  const subscriptions = await matterApiService.findSubscriptionsWithDeliveryOnDate(dateKey, { includeKitchenInputs: true });
  if (subscriptions.length === 0) {
    const empty = {
      ...(freshInputs ? { kitchenInputs: [], kitchenRoster: [], rosterComplete: true } : {}),
      matterSubscriptionsChecked: 0,
      alreadyCovered: 0,
      newlyCreatedCustomers: 0,
      customersAssigned: 0,
      matterCoreCustomersAssigned: 0,
      snackOnlyCustomersAssigned: 0,
      matterCoreSnackOnlyCustomersAssigned: 0,
      assignedMainMeals: null,
      assignedSnacks: null,
      assignedSnacksOnly: null,
      assignedMatterCore: null,
      assignedMatterCoreSnacksOnly: null
    };
    await cacheSet(cacheKey, empty, 60);
    return { data: empty };
  }

  const existingRecords = await MenuSelectionRecord.find({ weeklyMenuId: menuId })
    .select('email legacyStorageEmail matterEmail matterCustomerId matterSubscriptionId selectedMeals skippedDays').lean();
  const matterInputs = subscriptions.map((sub) => sub.kitchen_inputs).filter(Boolean);
  const sourceOptions = { matterInputs };
  let alreadyCovered = 0;
  const newlyCreatedCustomers = 0; // Compatibility: kitchen never creates Internal customers.
  const needsAssignment = [], needsMatterCoreAssignment = [], needsSnackOnly = [], needsMatterCoreSnackOnly = [];
  for (const sub of subscriptions) {
    const nutrition = sub.kitchen_inputs;
    const identity = matterSelectionIdentity(nutrition);
    const matches = existingRecords.filter((record) => record.matterCustomerId
      ? String(record.matterCustomerId) === identity.matterCustomerId
      : normalizeMatterEmail(record.matterEmail || record.email) === identity.matterEmail
        || String(record.matterSubscriptionId || '') === identity.matterSubscriptionId);
    if (matches.length > 1) throw new Error('Multiple saved selections match the same Matter customer. Resolve the duplicate selection before production.');
    const record = matches[0];
    if (record && (!record.matterCustomerId || record.matterEmail !== identity.matterEmail || record.matterSubscriptionId !== identity.matterSubscriptionId || normalizeMatterEmail(record.email) !== identity.matterEmail)) {
      const resolved = { ...identity, email: identity.matterEmail,
        ...(normalizeMatterEmail(record.email) !== identity.matterEmail ? { legacyStorageEmail: record.legacyStorageEmail || record.email } : {}) };
      await MenuSelectionRecord.updateOne({ _id: record._id }, { $set: resolved });
      Object.assign(record, resolved);
    }
    if (await kitchenDateUnavailable(record, dateKey, nutrition)) continue;
    const core = String(nutrition.plan_name || '').trim().toLowerCase() === 'matter core';
    const portions = (record?.selectedMeals || []).filter((meal) => toDateKey(meal.date) === dateKey && (core ? meal.mealType === 'main' : meal.mealType !== 'snack'))
      .reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
    const item = { ...identity, email: record?.email || identity.matterEmail,
      name: nutrition.customer_name, subscriptionId: identity.matterSubscriptionId,
      mealFrequency: nutrition.meal_frequency, breakfastIncluded: nutrition.breakfast_included,
      exclusions: nutrition.exclusions || [], nutrition,
    };
    const required = Math.max(1, Number(nutrition.meal_frequency) || 1) * (core && isMatterCoreDoubleDay(dateKey, nutrition.active_delivery_dates) ? 2 : 1);
    if (portions >= required) {
      alreadyCovered++;
      (core ? needsMatterCoreSnackOnly : needsSnackOnly).push(item);
    } else (core ? needsMatterCoreAssignment : needsAssignment).push(item);
  }

  let assignedMainMeals = null;
  let assignedSnacks = null;
  if (needsAssignment.length > 0) {
    const mainResult = await runAssignMainMeals(menuId, dateKey, needsAssignment, sourceOptions);
    assignedMainMeals = mainResult.error ? { error: mainResult.error } : mainResult.data;

    const snackResult = await runAssignSnacks(menuId, {
      date: dateKey,
      customers: needsAssignment
    }, sourceOptions);
    assignedSnacks = snackResult.error ? { error: snackResult.error } : snackResult.data;
  }

  let assignedSnacksOnly = null;
  if (needsSnackOnly.length > 0) {
    const snackOnlyResult = await runAssignSnacks(menuId, {
      date: dateKey,
      customers: needsSnackOnly
    }, sourceOptions);
    assignedSnacksOnly = snackOnlyResult.error ? { error: snackOnlyResult.error } : snackOnlyResult.data;
  }

  let assignedMatterCore = null;
  if (needsMatterCoreAssignment.length > 0) {
    const matterCoreResult = await runAssignMatterCoreMeals(menuId, dateKey, needsMatterCoreAssignment, sourceOptions);
    assignedMatterCore = matterCoreResult.error ? { error: matterCoreResult.error } : matterCoreResult.data;
  }

  let assignedMatterCoreSnacksOnly = null;
  if (needsMatterCoreSnackOnly.length > 0) {
    const matterCoreSnackOnlyResult = await runAssignMatterCoreMeals(
      menuId,
      dateKey,
      needsMatterCoreSnackOnly,
      { ...sourceOptions, snackOnly: true, includeBreakfast: true }
    );
    assignedMatterCoreSnacksOnly = matterCoreSnackOnlyResult.error
      ? { error: matterCoreSnackOnlyResult.error }
      : matterCoreSnackOnlyResult.data;
  }

  const summary = {
    ...(freshInputs ? {
      kitchenInputs: subscriptions.map((sub) => sub.kitchen_inputs).filter(Boolean),
      kitchenRoster: subscriptions.map(({ kitchen_inputs, ...subscription }) => subscription),
      rosterComplete: true
    } : {}),
    matterSubscriptionsChecked: subscriptions.length,
    alreadyCovered,
    newlyCreatedCustomers,
    customersAssigned: needsAssignment.length,
    matterCoreCustomersAssigned: needsMatterCoreAssignment.length,
    snackOnlyCustomersAssigned: needsSnackOnly.length,
    matterCoreSnackOnlyCustomersAssigned: needsMatterCoreSnackOnly.length,
    assignedMainMeals,
    assignedSnacks,
    assignedSnacksOnly,
    assignedMatterCore,
    assignedMatterCoreSnacksOnly
  };

  // 15 min TTL — long enough to cover a kitchen shift's repeat page loads
  // for the same date without re-running the expensive Matter sweep, short
  // enough that a delivery-schedule change or new submission is picked up
  // again soon.
  if (preparationHasFailures(summary)) {
    await cacheDelete(cacheKey);
    throw kitchenPreparationFailure(summary, dateKey);
  }
  const cachedSummary = { ...summary };
  delete cachedSummary.kitchenInputs;
  delete cachedSummary.kitchenRoster;
  delete cachedSummary.rosterComplete;
  await cacheSet(cacheKey, cachedSummary, 60);
  return { data: summary };
}

router.get('/:id/kitchen-state', protect, async (req, res) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') || toDateKey(req.query.date) !== req.query.date) return res.status(400).json({ success: false, message: 'Select a valid date.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...await readKitchenState(req.params.id, req.query.date, req.query.job) });
  } catch (error) { return res.status(error.statusCode || 503).json({ success: false, message: error.message, code: error.code, selectionWindow: error.selectionWindow }); }
});

router.post('/:id/kitchen-state', protect, async (req, res) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') || toDateKey(req.body.date) !== req.body.date) return res.status(400).json({ success: false, message: 'Select a valid date.' });
    const state = await beginKitchenState(req.params.id, req.body.date, () => runAutoPopulateMissing(req.params.id, req.body.date, { freshInputs: true }));
    return res.status(state.state === 'running' ? 202 : 200).json({ success: true, ...state });
  } catch (error) { return res.status(error.statusCode || 503).json({ success: false, message: error.message, code: error.code, selectionWindow: error.selectionWindow }); }
});

router.post('/:id/kitchen-upload', protect, async (req, res) => {
  try { return res.json({ success: true, data: await kitchenUpload(req.params.id, req.body) }); }
  catch (error) { return res.status(error.statusCode || 503).json({ success: false, message: error.message }); }
});

router.post('/:id/auto-populate-missing', protect, async (req, res) => {
  try {
    const { date } = req.body || {};
    const dateKey = toDateKey(date);
    if (!dateKey) {
      return res.status(400).json({ success: false, message: 'A valid date is required' });
    }

    res.set('Cache-Control', 'no-store');
    const result = await runAutoPopulateMissing(req.params.id, dateKey, { freshInputs: req.body?.freshInputs === true });
    await cacheDeletePattern(`menu:${req.params.id}:selections:*`);
    return res.json({ success: true, preparation: 'completed', preparedAt: new Date().toISOString(), data: result.data, cached: !!result.cached });
  } catch (error) {
    console.error('Error auto-populating missing selections:', error);
    return res.status(error.statusCode || 500).json({ success: false, code: error.code, preparation: 'failed', message: error.message, selectionWindow: error.selectionWindow,
      ...(error.code === 'KITCHEN_ASSIGNMENT_INCOMPLETE' ? { failures: error.failures } : {}) });
  }
});

/**
 * GET /api/menus/:id/main-meal-options
 * Returns the kitchen-defined main meal rotation + fallback sub meals, keyed by date.
 */
router.get('/:id/main-meal-options', protect, async (req, res) => {
  try {
    const menu = await WeeklyMenu.findById(req.params.id).select('mainMealOptionsByDate meals').lean();
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    const optionsByDate = {};
    for (const [date, value] of Object.entries(menu.mainMealOptionsByDate || {})) {
      optionsByDate[date] = { mainMeals: value?.mainMeals || [], subMeals: value?.subMeals || [] };
    }
    const derived = await getMenuItemRotationByDate(menu);
    for (const [date, value] of Object.entries(derived)) {
      if ((optionsByDate[date]?.mainMeals || []).length === 0 && value.mainMeals.length > 0) {
        optionsByDate[date] = { mainMeals: value.mainMeals, subMeals: value.subMeals };
      }
    }

    res.json({ success: true, data: optionsByDate });
  } catch (error) {
    console.error('Error fetching main meal options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/menus/:id/main-meal-options
 * Replaces the main meal rotation + fallback sub meals for one date, OR —
 * when `entries` is given — for many dates at once in a single save (used by
 * the weekly menu upload, which used to PUT once per date sequentially;
 * uploading a full week could mean 7+ round trips just for this one type).
 * Body: { date, mainMeals: [{name, type, exclusions}], subMeals: [...] }
 *   or: { entries: [{ date, mainMeals, subMeals }, ...] }
 */
router.put('/:id/main-meal-options', protect, async (req, res) => {
  try {
    const { date, mainMeals, subMeals, entries } = req.body || {};

    const normalize = (list) => (Array.isArray(list) ? list : [])
      .map((opt) => ({
        name: String(opt?.name || '').trim(),
        type: ['chicken', 'beef', 'fish'].includes(opt?.type) ? opt.type : null,
        exclusions: Array.isArray(opt?.exclusions)
          ? opt.exclusions.map((e) => String(e).trim()).filter(Boolean)
          : String(opt?.exclusions || '').split(',').map((e) => e.trim()).filter(Boolean)
      }))
      .filter((opt) => opt.name && opt.type);

    const menu = await WeeklyMenu.findById(req.params.id);
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    if (Array.isArray(entries) && entries.length > 0) {
      let appliedAny = false;
      for (const entry of entries) {
        const dateKey = toDateKey(entry?.date);
        if (!dateKey) continue;
        menu.mainMealOptionsByDate.set(dateKey, {
          mainMeals: normalize(entry?.mainMeals).slice(0, 3),
          subMeals: normalize(entry?.subMeals)
        });
        appliedAny = true;
      }
      if (!appliedAny) {
        return res.status(400).json({ success: false, message: 'No entry had a valid date' });
      }
    } else {
      const dateKey = toDateKey(date);
      if (!dateKey) {
        return res.status(400).json({ success: false, message: 'A valid date is required' });
      }
      menu.mainMealOptionsByDate.set(dateKey, {
        mainMeals: normalize(mainMeals).slice(0, 3),
        subMeals: normalize(subMeals)
      });
    }

    await menu.save();

    const optionsByDate = {};
    for (const [key, value] of menu.mainMealOptionsByDate.entries()) {
      optionsByDate[key] = { mainMeals: value?.mainMeals || [], subMeals: value?.subMeals || [] };
    }

    res.json({ success: true, data: optionsByDate });
  } catch (error) {
    console.error('Error saving main meal options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/menus/:id/matter-core-meal-options
 * Returns the kitchen-defined Matter Core meal rotation, keyed by date — a
 * plain ordered list, no type/exclusion fields (see matterCoreMealOptionSchema).
 */
router.get('/:id/matter-core-meal-options', protect, async (req, res) => {
  try {
    const menu = await WeeklyMenu.findById(req.params.id).select('matterCoreMealOptionsByDate').lean();
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    const optionsByDate = {};
    for (const [date, value] of Object.entries(menu.matterCoreMealOptionsByDate || {})) {
      optionsByDate[date] = Array.isArray(value) ? value : [];
    }

    res.json({ success: true, data: optionsByDate });
  } catch (error) {
    console.error('Error fetching Matter Core meal options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/menus/:id/matter-core-meal-options
 * Replaces the Matter Core meal list for one date, OR — when `entries` is
 * given — for many dates at once (same batch pattern as main-meal-options).
 * Body: { date, meals: [{name}] } or: { entries: [{ date, meals }, ...] }
 */
router.put('/:id/matter-core-meal-options', protect, async (req, res) => {
  try {
    const { date, meals, entries } = req.body || {};

    const normalize = (list) => (Array.isArray(list) ? list : [])
      .map((opt) => ({ name: String(opt?.name || '').trim() }))
      .filter((opt) => opt.name);

    const menu = await WeeklyMenu.findById(req.params.id);
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    if (Array.isArray(entries) && entries.length > 0) {
      let appliedAny = false;
      for (const entry of entries) {
        const dateKey = toDateKey(entry?.date);
        if (!dateKey) continue;
        menu.matterCoreMealOptionsByDate.set(dateKey, normalize(entry?.meals));
        appliedAny = true;
      }
      if (!appliedAny) {
        return res.status(400).json({ success: false, message: 'No entry had a valid date' });
      }
    } else {
      const dateKey = toDateKey(date);
      if (!dateKey) {
        return res.status(400).json({ success: false, message: 'A valid date is required' });
      }
      menu.matterCoreMealOptionsByDate.set(dateKey, normalize(meals));
    }

    await menu.save();

    const optionsByDate = {};
    for (const [key, value] of menu.matterCoreMealOptionsByDate.entries()) {
      optionsByDate[key] = value || [];
    }

    res.json({ success: true, data: optionsByDate });
  } catch (error) {
    console.error('Error saving Matter Core meal options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/menus/:id/assign-main-meals
 * Fills in a main meal (and, when the customer's profile has
 * breakfastInclude set, a breakfast) for each given customer on a date.
 * Main meals are assigned in a fixed type order — chicken, then beef, then
 * fish — one per slot, up to how many meals the customer needs. If a type's
 * main option is on the customer's exclusion list (or was already used
 * today), that slot falls back to the SUB meal of the SAME type, never a
 * different type's sub or the main/sub pool at large. A customer can never
 * receive the same dish twice in one day — every choice (main or sub) is
 * checked against what's already been assigned to them today first.
 *
 * When breakfastInclude is set, breakfast counts as one of the customer's
 * meal_frequency slots (e.g. meal_frequency 3 + breakfastInclude = 2 main
 * meals + 1 breakfast, not 3 main meals), and one breakfast is picked at
 * random from that date's breakfastOptionsByDate — filtered by the
 * customer's exclusions the same way main/sub meals and snacks are.
 *
 * Idempotent per customer: only fills the gap between their existing main
 * meals that day and their (breakfast-adjusted) meal_frequency, and never
 * adds a second breakfast if one already exists that day.
 * Body: { date, customers: [{ email, name, customerId, mealFrequency, exclusions }] }
 */
/**
 * Core "fill in main meals + breakfast" logic shared by the manual
 * POST /:id/assign-main-meals route (kitchen-staff-triggered, explicit
 * customer list from the UI) and the automatic auto-populate-missing route
 * (Stage 3 — runs the same assignment for Matter customers who never
 * submitted a selection at all). `customers` here is the same shape both
 * callers already use: [{ email, name, customerId, mealFrequency, exclusions }].
 */
async function runAssignMainMeals(menuId, dateKey, customers, { matterInputs = [] } = {}) {

    const menu = await WeeklyMenu.findById(menuId)
      .select('mainMealOptionsByDate breakfastOptionsByDate meals selectionDeadlines')
      .lean();
    if (!menu) {
      return { error: 'Menu not found', status: 404 };
    }
    assertKitchenSelectionClosed(menu, dateKey);
    customers = await canonicalizeAssignCustomers(menuId, customers, matterInputs);

    // Rotation candidates come from that day's MenuItem records (tagged
    // portionType + rotationCategory in the meal editor) rather than the
    // older mainMealOptionsByDate pool — the meal editor is now the single
    // place a dish's name/protein type/ingredients get entered, so the
    // rotation no longer needs a duplicate, hand-typed pool to stay in sync
    // with. `intolerances` (already a comma/semicolon/pipe list on MenuItem)
    // fills the same role mainMealOptionSchema.exclusions used to.
    const toOption = toKitchenOption;
    const allowedItemIds = (menu.meals || []).flatMap((day) => (day.items || []).map((item) => item._id || item));
    const dayMenuItems = await MenuItem.find({
      _id: { $in: allowedItemIds },
      itemDate: new Date(dateKey),
      mealType: 'main',
      rotationCategory: { $in: ['main', 'sub'] }
    }).lean();
    let mainMeals = dayMenuItems.filter((i) => i.rotationCategory === 'main').map(toOption);
    let subMeals = dayMenuItems.filter((i) => i.rotationCategory === 'sub').map(toOption);

    // Fallback for dates that haven't been tagged in the new meal editor yet
    // (e.g. a week planned before this switchover) — use the older,
    // manually-curated pool so auto-assign doesn't break for those dates.
    if (mainMeals.length === 0) {
      const dayOptions = (menu.mainMealOptionsByDate || {})[dateKey] || { mainMeals: [], subMeals: [] };
      mainMeals = dayOptions.mainMeals || [];
      subMeals = dayOptions.subMeals || [];
    }

    let breakfastOptions = (menu.breakfastOptionsByDate || {})[dateKey] || [];
    if (breakfastOptions.length === 0) {
      // No hand-built breakfast rotation for this date — use that day's
      // breakfast dishes from the menu file itself.
      const dayBreakfastItems = await MenuItem.find({ _id: { $in: (menu.meals || []).flatMap((day) => (day.items || []).map((item) => item._id || item)) }, itemDate: new Date(dateKey), mealType: 'breakfast' }).lean();
      breakfastOptions = dayBreakfastItems.map(toKitchenOption);
    }

    if (mainMeals.length === 0) {
      return { error: 'No main meals configured for this date', status: 400 };
    }

    // breakfastInclude lives on the Customer profile, not the Matter subscription
    // payload — batch-fetch it once for every customer being assigned.
    const breakfastIncludeByEmail = new Map(customers.map((c) => [normalizeMatterEmail(c.email), c.breakfastIncluded]));

    // Stable order so re-running is deterministic and repeatable.
    const sortedCustomers = [...customers].sort(
      (a, b) => String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''))
    );

    const MAIN_MEAL_TYPE_ORDER = ['chicken', 'beef', 'fish'];
    const nameKeyOf = (opt) => String(opt?.name || '').trim().toLowerCase();

    let assigned = 0;
    let skippedNoOption = 0;
    let skippedAlreadyAssigned = 0;
    let repeatedDish = 0;
    let assignedWithExclusionConflict = 0;
    const skippedCustomers = new Set();
    let assignedBreakfast = 0;
    let skippedBreakfastNoOption = 0;
    let substitutedBreakfastWithMain = 0;

    for (const customer of sortedCustomers) {
      const email = String(customer.email || '').trim();
      if (!email) continue;

      const existingRecord = await MenuSelectionRecord.findOne({ weeklyMenuId: menuId, email }).lean();
      if (await kitchenDateUnavailable(existingRecord, dateKey, customer.nutrition)) continue;
      const existingMainMealsCount = (existingRecord?.selectedMeals || []).filter(
        (m) => toDateKey(m.date) === dateKey && m.mealType === 'main'
      ).reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
      const hasBreakfastAlready = (existingRecord?.selectedMeals || []).some(
        (m) => toDateKey(m.date) === dateKey && m.mealType === 'breakfast'
      );

      const customerExclusions = (customer.exclusions || []).map((e) => String(e).toLowerCase().trim());

      // The Matter subscription's own breakfast_included flag (passed by the
      // caller) wins; the internal Customer profile is only the fallback.
      const breakfastInclude = typeof customer.breakfastIncluded === 'boolean'
        ? customer.breakfastIncluded
        : (breakfastIncludeByEmail.get(email.toLowerCase()) || false);
      const eligibleBreakfasts = breakfastOptions.filter((opt) => !optionExcludedByCustomer(opt, customerExclusions));
      // Breakfast only takes one of meal_frequency's slots if the customer
      // will actually GET one (or already has one). If there's no eligible
      // breakfast that day (no options, or every option hits their
      // exclusions), the slot goes back to a main meal — otherwise a 2-meal
      // customer ended up with 1 meal and no breakfast at all.
      const breakfastCoversASlot = breakfastInclude && (hasBreakfastAlready || eligibleBreakfasts.length > 0);
      const baseMealFrequency = Math.max(1, Number(customer.mealFrequency) || 1);
      const totalNeeded = Math.max(0, baseMealFrequency - (breakfastCoversASlot ? 1 : 0));
      const slotsNeeded = totalNeeded - existingMainMealsCount;

      const assignedMeals = [];

      // Seed with what the customer already has today, so a re-run (or a
      // customer who already self-selected some meals) never duplicates a
      // dish they already have, on top of never duplicating within this run.
      const assignedNamesToday = new Set(
        (existingRecord?.selectedMeals || [])
          .filter((m) => toDateKey(m.date) === dateKey && m.mealType === 'main')
          .map((m) => String(m.mealName || '').trim().toLowerCase())
      );

      if (slotsNeeded > 0) {
        // One type per slot, in order — chicken, beef, fish. Slots beyond 3
        // (an unusually high meal count) cycle back through the type order;
        // the no-duplicate-dish check below still applies, so a repeated
        // type only succeeds if that type's pool has more than one option.
        const typesForSlots = [];
        for (let slot = 0; slot < slotsNeeded; slot += 1) {
          typesForSlots.push(MAIN_MEAL_TYPE_ORDER[slot % MAIN_MEAL_TYPE_ORDER.length]);
        }

        typesForSlots.forEach((type) => {
          let chosen = null;
          const isEligible = (opt) => !optionExcludedByCustomer(opt, customerExclusions)
            && !assignedNamesToday.has(nameKeyOf(opt));

          // Owner request: a slot should never stay empty. Walk the types
          // starting at this slot's own type and wrapping around the
          // chicken → beef → fish order; for each type try its main first,
          // then its sub, before moving to the next type (main of type 1,
          // sub of type 1, main of type 2, sub of type 2, main of type 3,
          // sub of type 3).
          const startIndex = MAIN_MEAL_TYPE_ORDER.indexOf(type);
          for (let offset = 0; offset < MAIN_MEAL_TYPE_ORDER.length && !chosen; offset += 1) {
            const tryType = MAIN_MEAL_TYPE_ORDER[(startIndex + offset) % MAIN_MEAL_TYPE_ORDER.length];
            chosen = mainMeals.find((m) => m.type === tryType && isEligible(m))
              || subMeals.find((s) => s.type === tryType && isEligible(s))
              || null;
          }

          // Owner (2026-09-30): a slot must never be skipped. If every dish
          // that day is already on this customer's plate (e.g. a 4-meal
          // customer on a day with only 3 dishes), repeat one — same type
          // walk, exclusions still respected. Only when EVERY dish hits their
          // exclusions is the slot left empty (never serve an excluded dish).
          if (!chosen) {
            for (let offset = 0; offset < MAIN_MEAL_TYPE_ORDER.length && !chosen; offset += 1) {
              const tryType = MAIN_MEAL_TYPE_ORDER[(startIndex + offset) % MAIN_MEAL_TYPE_ORDER.length];
              chosen = mainMeals.find((m) => m.type === tryType && !optionExcludedByCustomer(m, customerExclusions))
                || subMeals.find((s) => s.type === tryType && !optionExcludedByCustomer(s, customerExclusions))
                || null;
            }
            if (chosen) repeatedDish += 1;
          }

          // Owner (2026-09-30): never leave a slot empty. If every dish that
          // day hits the customer's exclusions, give the one that clashes
          // with the fewest (type order breaks ties) and save the clashing
          // exclusions on the meal — it shows as "Needs attention" on the
          // Kitchen List and kitchen paper so it's swapped before it goes out.
          if (!chosen) {
            const conflictsFor = (opt) => {
              return kitchenConflictList(opt, customerExclusions);
            };
            let best = null;
            for (let offset = 0; offset < MAIN_MEAL_TYPE_ORDER.length; offset += 1) {
              const tryType = MAIN_MEAL_TYPE_ORDER[(startIndex + offset) % MAIN_MEAL_TYPE_ORDER.length];
              [...mainMeals, ...subMeals]
                .filter((opt) => opt.type === tryType)
                .forEach((opt) => {
                  const conflicts = conflictsFor(opt);
                  if (!best || conflicts.length < best.conflicts.length) best = { opt, conflicts };
                });
            }
            if (best) {
              chosen = { ...best.opt, _exclusionConflict: best.conflicts };
              assignedWithExclusionConflict += 1;
            }
          }

          if (chosen) {
            assignedNamesToday.add(nameKeyOf(chosen));
            assignedMeals.push(chosen);
            assigned += 1;
          } else {
            skippedNoOption += 1;
            skippedCustomers.add(customer.name || email);
          }
        });
      } else {
        skippedAlreadyAssigned += 1;
      }

      const newMeals = assignedMeals.map((meal, index) => ({
        date: new Date(dateKey),
        mealType: 'main',
        // Only MenuItem-sourced options have a real _id (the fallback pool's
        // options are plain name/type/exclusions tuples, no document behind them).
        menuItemId: meal._id || undefined,
        mealName: meal.name,
        manualProteinType: meal.type,
        quantity: 1,
        // Disambiguates same-mealType slots (e.g. a 3rd meal, also labeled
        // "main") so they're never mistaken for duplicates of each other
        // when read back — see the mealType/slotNumber consolidation key in
        // GET /:id/selections.
        slotNumber: existingMainMealsCount + index,
        exclusionConflict: meal._exclusionConflict || [],
        ...kitchenConflictFields(meal, customerExclusions),
        isAutoAssigned: true
      }));

      if (breakfastInclude && !hasBreakfastAlready) {
        if (eligibleBreakfasts.length > 0) {
          const choice = eligibleBreakfasts[Math.floor(Math.random() * eligibleBreakfasts.length)];
          newMeals.push({
            date: new Date(dateKey),
            mealType: 'breakfast',
            mealName: choice.name,
            quantity: 1,
            isAutoAssigned: true
          });
          assignedBreakfast += 1;
        } else {
          // The existing standard-plan policy returns an unavailable breakfast's
          // slot to the main meals above. A fulfilled replacement is not a gap.
          if (existingMainMealsCount + assignedMeals.length >= baseMealFrequency) substitutedBreakfastWithMain += 1;
          else skippedBreakfastNoOption += 1;
        }
      }

      if (newMeals.length === 0) continue;

      await assertAssignmentMacros(newMeals);
      await appendKitchenMeals(menuId, email, existingRecord,
        {
          $setOnInsert: {
            weeklyMenuId: menuId,
            email,
            // customerRef is only supplied by the auto-populate job (Stage 3),
            // which already resolved the internal Customer — the manual UI
            // path doesn't have it and falls back to the email-based index.
            matterCustomerId: customer.matterCustomerId,
          matterEmail: customer.matterEmail,
          matterSubscriptionId: customer.matterSubscriptionId,
            customerId: customer.customerId ? String(customer.customerId) : undefined,
            firstName: customer.name || email
          },
          $push: { selectedMeals: { $each: newMeals } }
        }
      );
    }

    return {
      data: {
        assigned,
        skippedNoOption,
        skippedAlreadyAssigned,
        repeatedDish,
        assignedWithExclusionConflict,
        skippedCustomers: Array.from(skippedCustomers),
        assignedBreakfast,
        skippedBreakfastNoOption,
        substitutedBreakfastWithMain,
        customersProcessed: sortedCustomers.length
      }
    };
}

/**
 * Kitchen List → "Assign Partner Meals". Owner (2026-09-29): kitchen staff
 * pick a Partner, then one of its members (a Customer linked via
 * Customer.partner), and add that date's dishes to them by hand. Those
 * members get fixed Lean-plan macros (C35 P30 F15 per main meal — applied in
 * kitchenListCalculations) and print under the kitchen paper's "Partners"
 * section, not by emirate.
 */
router.get('/kitchen-partners', protect, async (req, res) => {
  try {
    const partners = await Partner.find({})
      .select('businessName businessType')
      .sort({ businessName: 1 })
      .lean();
    return res.json({ success: true, data: partners });
  } catch (error) {
    console.error('Error listing kitchen partners:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/kitchen-partners/:partnerId/members', protect, async (_req, res) => res.status(409).json({ success: false, message: 'This legacy workflow used Internal customer records. Kitchen customers must be verified in Matter.' }));

/**
 * GET /api/menus/:id/day-dishes?date=YYYY-MM-DD
 * Every dish available on that date, for the partner-meal picker: main
 * dishes from the meal editor's MenuItem records (falling back to the older
 * mainMealOptionsByDate pool), plus the date's breakfast and snack options.
 */
router.get('/:id/day-dishes', protect, async (req, res) => {
  try {
    const dateKey = toDateKey(req.query.date);
    if (!dateKey) {
      return res.status(400).json({ success: false, message: 'A valid date is required' });
    }
    const menu = await WeeklyMenu.findById(req.params.id)
      .select('mainMealOptionsByDate breakfastOptionsByDate snackOptionsByDate')
      .lean();
    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    const items = await MenuItem.find({ itemDate: new Date(dateKey) })
      .select('mealName mealType')
      .lean();
    const seen = new Set();
    const pushUnique = (list, entry) => {
      const key = `${entry.mealType}::${String(entry.mealName).trim().toLowerCase()}`;
      if (!entry.mealName || seen.has(key)) return;
      seen.add(key);
      list.push(entry);
    };

    const dishes = [];
    items.forEach((item) => {
      const mealType = ['breakfast', 'snack'].includes(item.mealType) ? item.mealType : 'main';
      pushUnique(dishes, { mealType, mealName: item.mealName, menuItemId: item._id });
    });
    const legacyMain = (menu.mainMealOptionsByDate || {})[dateKey] || {};
    [...(legacyMain.mainMeals || []), ...(legacyMain.subMeals || [])]
      .forEach((opt) => pushUnique(dishes, { mealType: 'main', mealName: opt.name }));
    ((menu.breakfastOptionsByDate || {})[dateKey] || [])
      .forEach((opt) => pushUnique(dishes, { mealType: 'breakfast', mealName: opt.name }));
    const snackPools = (menu.snackOptionsByDate || {})[dateKey];
    const snackList = Array.isArray(snackPools)
      ? snackPools
      : [...(snackPools?.first || []), ...(snackPools?.second || [])];
    snackList.forEach((opt) => pushUnique(dishes, { mealType: 'snack', mealName: opt.name }));

    return res.json({ success: true, data: dishes });
  } catch (error) {
    console.error('Error listing day dishes:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/menus/:id/partner-meals
 * Body: { date, customerId (Customer _id), meals: [{ mealType, mealName, menuItemId?, quantity }] }
 * Appends the meals to that member's selection for this menu (creating the
 * record if needed), marked isAutoAssigned so they never show in the
 * customer-facing selection preview.
 */
router.post('/:id/partner-meals', protect, async (_req, res) => res.status(409).json({ success: false, message: 'This legacy workflow used Internal customer records. Kitchen customers must be verified in Matter.' }));

router.post('/:id/assign-main-meals', protect, async (req, res) => {
  try {
    const { date, customers } = req.body || {};
    const dateKey = toDateKey(date);
    if (!dateKey) {
      return res.status(400).json({ success: false, message: 'A valid date is required' });
    }
    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ success: false, message: 'customers must be a non-empty array' });
    }

    const result = await runAssignMainMeals(req.params.id, dateKey, customers);
    if (result.error) {
      return res.status(result.status).json({ success: false, message: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (error) {
    console.error('Error assigning main meals:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, code: error.code, selectionWindow: error.selectionWindow });
  }
});

/**
 * GET /api/menus/share/:token
 * Access menu via share link (public)
 */
router.get('/share/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const cacheKey = `menu:share:${token}`;

    // Try to get from cache first (5 minute TTL for share links)
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        cached: true
      });
    }

    const menu = await WeeklyMenu.findOne({
      'shareLink.token': token
    })
      .populate({
        path: 'meals.items',
        model: 'MenuItem'
      });

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: 'Menu not found or link expired'
      });
    }

    if (menu.shareLink?.isActive === false) {
      return res.status(410).json({
        success: false,
        message: 'This link is expired'
      });
    }

    // Check if link has expired
    if (menu.shareLink.expiresAt && new Date() > menu.shareLink.expiresAt) {
      // Auto-extend expired links by 30 days
      menu.shareLink.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await menu.save();
    }

    // Increment view count
    menu.viewCount += 1;
    await menu.save();

    // Cache the response for 5 minutes
    await cacheSet(cacheKey, menu.toObject(), 300);

    console.log('=== Returning menu from /share/:token ===');
    console.log('Menu ID:', menu._id);
    console.log('enableCompletionMessage:', menu.enableCompletionMessage);
    console.log('completionMessage:', menu.completionMessage);

    res.json({
      success: true,
      data: menu
    });
  } catch (error) {
    console.error('Error fetching shared menu:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/menus/:id
 * Get a weekly menu with populated items (admin only)
 */
router.get('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(404).json({
        success: false,
        message: 'Menu not found'
      });
    }

    const menu = await WeeklyMenu.findById(id)
      .populate({ path: 'meals.items', model: 'MenuItem' });

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: 'Menu not found'
      });
    }

    return res.json({
      success: true,
      data: menu
    });
  } catch (error) {
    console.error('Error fetching menu:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * POST /api/menus
 * Create a new weekly menu (admin only)
 */
const saveMenuResponse = async (req, res, creating) => {
  try {
    if (!creating && !isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Menu not found' });
    const menu = await saveManagedMenu({
      menuId: creating ? null : req.params.id, body: req.body, userId: req.user._id,
      buildMealName, mergeUploadedSnackPools,
    });
    const warnings = [];
    if (menu.shareLink?.token) {
      try { await cacheDelete(`menu:share:${menu.shareLink.token}`); }
      catch { warnings.push('Menu saved, but its public cache could not be refreshed. Retry the public menu shortly.'); }
    }
    if (menu.isPublished) {
      try { await syncMenuSelectionMainMealsToPartnerMenu(menu); }
      catch (error) {
        console.error('Partner menu sync failed after menu commit:', error.message);
        warnings.push('Menu saved. Partner synchronization failed; retry publishing to synchronize partner dishes.');
      }
    }
    return res.status(creating ? 201 : 200).json({
      success: true, message: creating ? 'Menu created successfully' : 'Menu updated successfully', data: menu, warnings,
    });
  } catch (error) {
    console.error('Menu save failed:', error.message);
    return res.status(error.statusCode || (error.name === 'ValidationError' ? 400 : 503)).json({
      success: false, message: error.message, ...(error.conflicts ? { conflicts: error.conflicts } : {}),
    });
  }
};

router.post('/', protect, (req, res) => saveMenuResponse(req, res, true));

/**
 * PUT /api/menus/:id
 * Update weekly menu (admin only)
 */
router.put('/:id', protect, (req, res) => saveMenuResponse(req, res, false));

/**
 * GET /api/menus/:id/share-link
 * Get shareable link for menu
 */
router.get('/:id/share-link', protect, async (req, res) => {
  try {
    const { id } = req.params;

    const menu = await WeeklyMenu.findById(id);

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: 'Menu not found'
      });
    }

    const fallbackOrigin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${process.env.FRONTEND_URL || fallbackOrigin}/menu-select/${menu.shareLink.token}`;

    res.json({
      success: true,
      data: {
        shareLink: menu.shareLink.token,
        shareUrl,
        expiresAt: menu.shareLink.expiresAt
      }
    });
  } catch (error) {
    console.error('Error getting share link:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * DELETE /api/menus/:id
 * Delete weekly menu (admin only)
 */
router.delete('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const menu = await WeeklyMenu.findById(id);

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: 'Menu not found'
      });
    }

    if (menu.isPublished || await MenuSelectionRecord.exists({ weeklyMenuId: id })) {
      return res.status(409).json({ success: false, message: 'This menu is published or has customer selection history. Unpublish or archive it instead of deleting selected dishes.' });
    }

    await WeeklyMenu.findByIdAndDelete(id);

    return res.json({
      success: true,
      message: 'Menu deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting menu:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/menus/:id/selections
 * Get customers who selected this menu (admin only).
 * Reads local meal choices only. Matter supplies customer details separately.
 * This GET never backfills or reads Internal Customer records.
 */
router.get('/:id/selections', protect, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const records = await MenuSelectionRecord.find({ weeklyMenuId: req.params.id })
      .populate('selectedMeals.menuItemId', '_id mealName mealType itemDate portionType rotationCategory usedForCorePlan')
      .sort({ submittedAt: -1 });
    const rows = records.map(record => record.toObject ? record.toObject() : record);
    const aliases = rows.filter(row => !row.matterCustomerId).map(row => row.email);
    const archives = aliases.length ? await MenuSelectionArchive.find({
      'original.weeklyMenuId': new mongoose.Types.ObjectId(req.params.id), 'original.email': { $in: aliases },
    }).lean() : [];
    const visible = excludeRecreatedArchivedAliases(rows, archives);
    res.json({ success: true, data: visible.map((record) => {
      const row = record.toObject ? record.toObject() : record;
      return { _id: row._id, email: row.email, matterEmail: row.matterEmail || null,
        customerId: row.matterCustomerId || null, matterCustomerId: row.matterCustomerId || null,
        matterSubscriptionId: row.matterSubscriptionId || null,
        selectedMeals: row.selectedMeals || [], skippedDays: row.skippedDays || [], dayNotes: row.dayNotes || [],
        lastMenuSelectionDate: row.submittedAt, nutritionStatus: 'missing',
      };
    }) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================
// SUPY RECIPE SEARCH
// ============================================

/**
 * GET /api/menus/supy-recipes/search?q=chicken
 * Typeahead search over the retailer's Supy recipes, used by the meal
 * editor to pull a recipe's ingredients into a meal (portion/carb/veg/
 * sauce for lunch & dinner, or the whole meal for breakfast & snack).
 */
router.get('/supy-recipes/search', protect, async (req, res) => {
  try {
    const results = await supyService.searchRecipes(req.query.q);
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Error searching Supy recipes:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ============================================
// MENU ITEM ROUTES
// ============================================

/**
 * GET /api/menu-items
 * Get menu items with filters
 */
router.get('/items', async (req, res) => {
  try {
    const { date, mealType, mealPlan, isAvailable = true } = req.query;

    const query = {};
    if (isAvailable) query.isAvailable = true;
    if (date) query.itemDate = new Date(date);
    if (mealType) query.mealType = mealType;
    if (mealPlan) query.mealPlan = mealPlan;

    const items = await MenuItem.find(query).sort({ itemDate: 1, mealType: 1 });

    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Error fetching menu items:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * POST /api/menu-items
 * Create menu item (admin only)
 */
router.post('/items', protect, async (req, res) => {
  try {
    const {
      itemDate,
      mealType,
      mealName,
      mealPlan,
      description,
      ingredients,
      category,
      intolerances,
      garnish,
        veg,
        sauce,
      proteinSource,
      portionIngredients,
      carbIngredients,
      vegIngredients,
      sauceIngredients,
      portionType,
      rotationCategory,
      usedForCorePlan,
      calories,
      protein,
      carbs,
      fat,
      allergens,
      isVegan,
      isGlutenFree
    } = req.body;

    const item = new MenuItem({
      itemDate: new Date(itemDate),
      mealType,
      mealName,
      mealPlan,
      description,
      ingredients,
      category,
      intolerances,
      garnish,
      veg,
      sauce,
      proteinSource,
      portionIngredients,
      carbIngredients,
      vegIngredients,
      sauceIngredients,
      portionType,
      rotationCategory,
      usedForCorePlan,
      calories,
      protein,
      carbs,
      fat,
      allergens,
      isVegan,
      isGlutenFree
    });

    await item.save();

    res.status(201).json({
      success: true,
      message: 'Menu item created successfully',
      data: item
    });
  } catch (error) {
    console.error('Error creating menu item:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * POST /api/customers/:email/skip-pause-preview
 * Read-only: for each date the customer has currently marked as skipped in
 * the selection screen, return Matter's date availability — WITHOUT calling
 * Matter's pause endpoint. Powers the pause-confirmation calendar shown
 * before the customer confirms their submission (see select-meals below,
 * which applies whatever the customer actually confirms, not a recompute of
 * this preview).
 * Body: { dates: ["YYYY-MM-DD", ...] }
 */
router.post('/customers/:email/skip-pause-preview', async (req, res) => {
  try {
    const cleanEmail = String(req.params.email || '').trim();
    const dates = Array.isArray(req.body?.dates) ? req.body.dates.map(toDayKey).filter(Boolean) : [];
    if (!cleanEmail || dates.length === 0) {
      return res.json({ success: true, data: { subscriptionId: null, pauses: [] } });
    }

    let matterSub = null;
    try {
      matterSub = await matterApiService.getKitchenNutrition({ email: cleanEmail });
    } catch (matterError) {
      console.error('skip-pause-preview: Matter lookup failed for', cleanEmail, '-', matterError.message);
    }
    const preview = await previewSkipPauses({
      email: cleanEmail,
      // Match the exact Matter email used at sign-in. An internal match may
      // still point at the subscription from before the customer's renewal.
      matterSubscriptionId: matterSub?.subscription_id || null,
      matterCustomerId: matterSub?.customer_id || null,
      skippedDateKeys: dates,
      weekendEnabled: matterSub?.weekend_enabled === true
    });

    res.json({ success: true, data: preview });
  } catch (error) {
    console.error('Error previewing skip pauses:', error);
    // Show the lookup error in the calendar and require a retry before confirming.
    const dates = Array.isArray(req.body?.dates) ? req.body.dates.map(toDayKey).filter(Boolean) : [];
    res.json({
      success: true,
      data: { subscriptionId: null, availabilityError: 'Could not verify active deliveries with Matter. Please retry.', pauses: dates.map((date) => ({ date, alreadyPaused: false, resumeDate: null, error: error.message })) }
    });
  }
});

/**
 * POST /api/customers/:email/select-meals
 * Customer selects meals from weekly menu
 */
router.post('/customers/:email/select-meals', async (req, res) => {
  try {
    const { email } = req.params;
    const { weeklyMenuId, selections, macros, skippedDates, subscriptionId, pauseDecisions } = req.body;
    const cleanEmail = String(email || '').trim();
    // Logged onto the MenuSelectionRecord below — the customer-facing sign-in
    // (subscription-profile) resolves identity from this exact Matter
    // subscription, so recording it here traces which subscription a given
    // submission was actually made against.
    const cleanSubscriptionId = subscriptionId ? String(subscriptionId).trim() : undefined;

    // Days the customer explicitly skipped in the selection flow (deduped, normalized)
    let skippedDateKeys = Array.from(new Set(
      (Array.isArray(skippedDates) ? skippedDates : [])
        .map(toDayKey)
        .filter(Boolean)
    ));

    // What the customer actually confirmed in the pause-confirmation calendar
    // (skip-pause-preview -> SkipPauseCalendarModal), keyed by date: whether
    // to pause Matter deliveries for that day and on which resume date, or to
    // decline the pause entirely in legacy submissions. Every new pause now
    // requires an explicit resume date; missing/declined decisions are
    // rejected below before any meals are saved.
    const pauseDecisionByDate = new Map(
      (Array.isArray(pauseDecisions) ? pauseDecisions : [])
        .map((d) => [toDayKey(d?.date), d])
        .filter(([date]) => date)
    );

    console.log('=== POST /select-meals ===');
    console.log('Email:', cleanEmail);
    console.log('Selections received:', selections?.length || 0);
    if (selections && selections.length > 0) {
      console.log('First selection sample:', JSON.stringify(selections[0], null, 2));
      const totalWithQty = selections.reduce((sum, m) => sum + (m.quantity || 1), 0);
      console.log('Total meals (with quantity):', totalWithQty);
    }

    // Matter verifies the email and permanent ID. Internal Customer profiles
    // are intentionally neither read nor written by menu submission.
    let matterSub = null;
    try {
      matterSub = await matterApiService.getKitchenNutrition({ email: cleanEmail });
    } catch (matterError) {
      console.error('select-meals: Matter lookup failed for', cleanEmail, '-', matterError.message);
      return res.status(matterError.statusCode || 502).json({ success: false, message: matterError.statusCode === 409 ? matterError.message : 'Could not verify your Matter subscription. Please retry before submitting.' });
    }
    if (!matterSub) return res.status(409).json({ success: false, message: 'A verified Matter subscription is required to submit meals.' });

    const identity = matterSelectionIdentity(matterSub);
    if (req.body.matterCustomerId && String(req.body.matterCustomerId) !== identity.matterCustomerId) return res.status(409).json({ success: false, message: 'Your Matter account changed. Sign in again before submitting.' });
    const customer = { ...identity, email: identity.matterEmail, selectedMeals: [] };
    const selectionFilter = matterSelectionFilter(weeklyMenuId, matterSub);

    // Require an explicit date for every new pause before saving anything.
    const prior = weeklyMenuId ? await MenuSelectionRecord.findOne(selectionFilter)
      .select('skippedDays').lean() : null;
    const priorByDate = new Map((prior?.skippedDays || []).filter(day => !day.resumedAt).map((s) => [toDayKey(s.date), s]));
    skippedDateKeys = [...new Set([...priorByDate.keys(), ...skippedDateKeys])].sort();
    const alreadyPaused = new Set([...priorByDate].filter(([, p]) => ['success', 'already_paused'].includes(p.pauseStatus)).map(([date]) => date));
    const claimedExisting = [...pauseDecisionByDate.values()].filter((d) => d.alreadyPaused && !alreadyPaused.has(toDayKey(d.date)));
    const includesSaturday = skippedDateKeys.some((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 6);
    if (claimedExisting.length || includesSaturday) {
      const ctx = await resolveSubscriptionContext({ email: cleanEmail, matterSubscriptionId: matterSub?.subscription_id || identity.matterSubscriptionId, matterCustomerId: matterSub?.customer_id || null });
      if (ctx.error) return res.status(502).json({ success: false, message: ctx.error });
      skippedDateKeys = expandSaturdaySkips(skippedDateKeys, new Set([...ctx.activeDeliveryDates, ...ctx.existingPaused]));
      claimedExisting.forEach((d) => {
        d.alreadyPaused = ctx.existingPaused.has(toDayKey(d.date));
        if (d.alreadyPaused) alreadyPaused.add(toDayKey(d.date));
      });
    }
    const resumeError = validateRequiredResumeDates({ skippedDateKeys, decisions: [...pauseDecisionByDate.values()], alreadyPaused });
    if (resumeError) return res.status(400).json({ success: false, message: resumeError });

    // Explicitly map selections to ensure quantity is preserved
    const mappedSelections = (selections || []).filter((sel) => !skippedDateKeys.includes(toDayKey(sel.date))).map(sel => ({
      date: sel.date,
      mealType: sel.mealType,
      menuItemId: toMenuItemId(sel.menuItemId),
      mealName: sel.mealName,
      description: sel.description,
      slotNumber: sel.slotNumber,
      proteinChoice: sel.proteinChoice,
      vegChoice: sel.vegChoice,
      carbChoice: sel.carbChoice,
      sauceChoice: sel.sauceChoice,
      manualProteinType: String(sel.manualProteinType || '').trim().toLowerCase(),
      quantity: Number(sel.quantity) || 1,  // Explicitly convert to number
      carbVegAction: sel.carbVegAction || undefined,
      carbVegConflict: sel.carbVegConflict?.length ? sel.carbVegConflict : undefined,
      carbConflict: sel.carbConflict?.length ? sel.carbConflict : undefined,
      vegConflict: sel.vegConflict?.length ? sel.vegConflict : undefined,
      // Sauce/garnish exclusion matches never reach the customer — this flag
      // is computed client-side (handleMealSelect) and just passed through
      // here for Kitchen List to surface to staff.
      needsSauceChange: !!sel.needsSauceChange,
      needsGarnishChange: !!sel.needsGarnishChange,
      sauceConflict: sel.sauceConflict?.length ? sel.sauceConflict : undefined,
      garnishConflict: sel.garnishConflict?.length ? sel.garnishConflict : undefined
    }));

    console.log('Mapped selections with quantity:', mappedSelections.map(s => ({ 
      mealName: s.mealName, 
      quantity: s.quantity,
      quantityType: typeof s.quantity
    })));

    customer.selectedMeals = mappedSelections;
    const resolvedMacros = undefined; // Portion inputs always come from Matter at calculation time.
    const matterExclusion = (matterSub.exclusions || []).join(', ');

    // Upsert a MenuSelectionRecord so historical selections per menu are preserved
    // even after the customer moves on to a newer menu week.
    // A date a prior submit already resolved to success/already_paused must
    // never be re-applied to Matter.
    if (weeklyMenuId) {
      // Merge skipped days: keep a prior successful/already-paused outcome for a
      // date that's still skipped (so a re-submit never double-pauses), mark
      // everything else pending for the background processor to (re)try.
      const skippedDays = skippedDateKeys.map((date) => {
        const p = priorByDate.get(date);
        if (p && (p.pauseStatus === 'success' || p.pauseStatus === 'already_paused')) {
          return {
            date,
            pauseStatus: p.pauseStatus,
            resumeDate: p.resumeDate,
            subscriptionId: p.subscriptionId,
            processedAt: p.processedAt
          };
        }
        return { date, pauseStatus: 'pending' };
      });

      await MenuSelectionRecord.findOneAndUpdate(
        selectionFilter,
        {
          $set: {
            weeklyMenuId,
            email: customer.email,
            customerId: customer.customerId,
            firstName: customer.firstName,
            lastName: customer.lastName,
            mealExclusion: matterExclusion,
            selectedMeals: mappedSelections,
            skippedDays,
            submittedAt: new Date(),
            macros: resolvedMacros,
            ...(matterSub ? {
              matterEmail: matterSub.customer_email || cleanEmail,
              matterCustomerId: matterSub.customer_id == null ? undefined : String(matterSub.customer_id),
              matterSubscriptionId: String(matterSub.subscription_id)
            } : (cleanSubscriptionId ? { matterSubscriptionId: cleanSubscriptionId } : {}))
          }
        },
        { upsert: true, new: true }
      );
      console.log('MenuSelectionRecord upserted for', customer.email, 'menu', weeklyMenuId, '- skipped days:', skippedDateKeys.length);
    }

    // Refresh selection count from MenuSelectionRecord (authoritative, never decrements on menu switch)
    if (weeklyMenuId) {
      const selectionTotal = await MenuSelectionRecord.countDocuments({ weeklyMenuId });
      await WeeklyMenu.findByIdAndUpdate(weeklyMenuId, { $set: { selectionCount: selectionTotal } });
    }

    // Apply the customer's CONFIRMED pause decisions (from the pause-
    // confirmation calendar, skip-pause-preview -> SkipPauseCalendarModal)
    // synchronously, before responding — the customer only sees "done" once
    // this has actually been attempted, never a server recompute of what
    // the customer explicitly selected. Matter failures are caught inside
    // applyConfirmedPauses, recorded on skippedDays, and returned for the
    // customer to review/retry. Skips any date a prior submit already resolved to
    // success/already_paused, same dedupe as the skippedDays build above, so
    // a re-submit never double-pauses.
    let pauseResults = [];
    if (weeklyMenuId && pauseDecisionByDate.size > 0) {
      const decisions = Array.from(pauseDecisionByDate.values())
        .map((d) => ({
          date: toDayKey(d.date),
          action: d.action === 'decline' ? 'decline' : 'pause',
          resumeDate: d.resumeDate,
          alreadyPaused: !!d.alreadyPaused
        }))
        .filter((d) => {
          const p = priorByDate.get(d.date);
          return !(p && (p.pauseStatus === 'success' || p.pauseStatus === 'already_paused'));
        });

      if (decisions.length > 0) {
        const needsMatter = decisions.some((d) => d.action === 'pause');
        let applied;
        if (!needsMatter) {
          applied = decisions.map((d) => ({ date: d.date, pauseStatus: 'declined' }));
        } else {
          const ctx = await resolveSubscriptionContext({
            email: cleanEmail,
            matterSubscriptionId: matterSub?.subscription_id || identity.matterSubscriptionId,
            matterCustomerId: matterSub?.customer_id || null
          });
          applied = ctx.error
            ? decisions.map((d) => (d.action === 'decline'
                ? { date: d.date, pauseStatus: 'declined' }
                : { date: d.date, pauseStatus: 'failed', error: ctx.error }))
            : await applyConfirmedPauses({ subscriptionId: ctx.subscriptionId, decisions });
        }

        pauseResults = applied;
        const outcomeByDate = new Map(applied.map((r) => [r.date, r]));
        const freshRecord = await MenuSelectionRecord.findOne(selectionFilter).select('skippedDays').lean();
        if (freshRecord) {
          const mergedSkippedDays = (freshRecord.skippedDays || []).map((s) => {
            const r = outcomeByDate.get(toDayKey(s.date));
            if (!r) return s;
            return {
              date: s.date,
              pauseStatus: r.pauseStatus,
              resumeDate: r.resumeDate || s.resumeDate,
              subscriptionId: r.subscriptionId || s.subscriptionId,
              error: r.pauseStatus === 'failed' ? r.error : undefined,
              processedAt: new Date()
            };
          });
          await MenuSelectionRecord.updateOne(selectionFilter, { $set: { skippedDays: mergedSkippedDays } });
        }
      }
    }

    res.json({
      success: true,
      message: 'Meals selected successfully',
      pauseResults,
      data: customer
    });

  } catch (error) {
    console.error('Error selecting meals:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * DELETE /api/menus/:menuId/selections/:email
 * Admin deletes a customer's selection record for a specific menu.
 */
router.delete('/:menuId/selections/:email', protect, async (req, res) => {
  try {
    const { menuId, email } = req.params;
    const cleanEmail = decodeURIComponent(String(email || '')).trim().toLowerCase();

    const deleted = await MenuSelectionRecord.findOneAndDelete({
      weeklyMenuId: menuId,
      email: { $regex: new RegExp(`^${cleanEmail}$`, 'i') }
    });

    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Selection record not found' });
    }

    // Only the selection record and menu counter belong to this operation.
    const selectionTotal = await MenuSelectionRecord.countDocuments({ weeklyMenuId: menuId });
    await WeeklyMenu.findByIdAndUpdate(menuId, { $set: { selectionCount: selectionTotal } });

    return res.json({ success: true, message: 'Selection deleted successfully' });
  } catch (error) {
    console.error('Error deleting selection:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Admin: update macro presets (breakfast / snack) for a customer's selection record
router.patch('/:menuId/selections/:email/macros-presets', protect, async (req, res) => {
  try {
    const { menuId } = req.params;
    const email = decodeURIComponent(req.params.email).trim().toLowerCase();
    const { breakfast, snack } = req.body;

    const update = {};
    if (breakfast) update['macros.presets.breakfast'] = breakfast;
    if (snack)     update['macros.presets.snack']     = snack;

    const record = await MenuSelectionRecord.findOneAndUpdate(
      { weeklyMenuId: menuId, email: { $regex: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
      { $set: update },
      { new: true }
    );

    if (!record) {
      return res.status(404).json({ success: false, message: 'Selection record not found' });
    }

    return res.json({ success: true, data: record.macros });
  } catch (error) {
    console.error('Error updating macro presets:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Kitchen-only note for a customer on one specific delivery day — shown in
// Kitchen List and printed on the Day Kitchen Paper for that date, never
// sent to the customer. Body: { date: "YYYY-MM-DD", note }. An empty/blank
// note removes that date's entry instead of storing a blank string.
router.patch('/:menuId/selections/:email/day-notes', protect, async (req, res) => {
  try {
    const { menuId } = req.params;
    const email = decodeURIComponent(req.params.email).trim();
    const { date, note } = req.body || {};

    const dateKey = toDateKey(date);
    if (!dateKey) {
      return res.status(400).json({ success: false, message: 'A valid date is required' });
    }

    const safeEmailRegex = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const trimmedNote = String(note || '').trim();

    const record = await MenuSelectionRecord.findOne({ weeklyMenuId: menuId, email: safeEmailRegex });
    if (!record) {
      return res.status(404).json({ success: false, message: 'Selection record not found' });
    }

    const existingIndex = (record.dayNotes || []).findIndex((n) => n.date === dateKey);
    if (!trimmedNote) {
      if (existingIndex >= 0) record.dayNotes.splice(existingIndex, 1);
    } else if (existingIndex >= 0) {
      record.dayNotes[existingIndex].note = trimmedNote;
    } else {
      record.dayNotes = record.dayNotes || [];
      record.dayNotes.push({ date: dateKey, note: trimmedNote });
    }

    await record.save();
    return res.json({ success: true, data: { dayNotes: record.dayNotes } });
  } catch (error) {
    console.error('Error saving day note:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Bulk-set a free-text remark on specific meals for one customer — driven by
// Kitchen List's "Upload Meal Remarks" Excel upload (matched by customer +
// date + meal name). Any text is accepted (not limited to a fixed set of
// keywords) — an empty remark clears it, same convention as dayNotes.
// Batched per customer (one call covers every row the upload had for them)
// rather than one request per meal, same reasoning as the weekly menu
// upload avoiding a round trip per row.
// Body: { entries: [{ date: "YYYY-MM-DD", mealName, remark }, ...] }
router.patch('/:menuId/selections/:email/meal-remarks', protect, async (req, res) => {
  try {
    const { menuId } = req.params;
    const email = decodeURIComponent(req.params.email).trim();
    const { entries } = req.body || {};

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ success: false, message: 'entries must be a non-empty array' });
    }

    const safeEmailRegex = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const record = await MenuSelectionRecord.findOne({ weeklyMenuId: menuId, email: safeEmailRegex });
    if (!record) {
      return res.status(404).json({ success: false, message: 'Selection record not found' });
    }

    const normalizeMealName = (value) => String(value || '').trim().toLowerCase();

    let updated = 0;
    const unmatched = [];

    entries.forEach((entry) => {
      const dateKey = toDateKey(entry?.date);
      const mealNameKey = normalizeMealName(entry?.mealName);
      if (!dateKey || !mealNameKey) {
        unmatched.push({ date: entry?.date, mealName: entry?.mealName, reason: 'invalid date or meal name' });
        return;
      }

      const sameDateAndName = (record.selectedMeals || []).filter(
        (m) => toDateKey(m.date) === dateKey && normalizeMealName(m.mealName) === mealNameKey
      );
      // The Kitchen List meal card also sends slotNumber so two portions of
      // the same dish on one day can carry different remarks.
      const meal = (entry?.slotNumber !== undefined && entry?.slotNumber !== null
        && sameDateAndName.find((m) => m.slotNumber === entry.slotNumber))
        || sameDateAndName[0];
      if (!meal) {
        unmatched.push({ date: dateKey, mealName: entry.mealName, reason: 'no matching meal on that date' });
        return;
      }

      meal.remark = String(entry.remark || '').trim();
      updated += 1;
    });

    if (updated > 0) await record.save();

    return res.json({ success: true, data: { updated, unmatched } });
  } catch (error) {
    console.error('Error saving meal remarks:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Admin override: update a customer's meal selections for a given menu
router.put('/:menuId/selections/:email', protect, async (req, res) => {
  try {
    const { menuId } = req.params;
    const email = decodeURIComponent(req.params.email).trim();
    const { selections } = req.body;

    if (!Array.isArray(selections)) {
      return res.status(400).json({ success: false, message: 'selections must be an array' });
    }

    const menu = await WeeklyMenu.findById(menuId);
    if (!menu) return res.status(404).json({ success: false, message: 'Menu not found' });

    const safeEmailRegex = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

    const normalizedSelections = selections.map((sel) => ({
      date: sel.date,
      mealType: sel.mealType,
      menuItemId: toMenuItemId(sel.menuItemId),
      mealName: sel.mealName,
      description: sel.description,
      slotNumber: sel.slotNumber,
      proteinChoice: sel.proteinChoice,
      vegChoice: sel.vegChoice,
      carbChoice: sel.carbChoice,
      sauceChoice: sel.sauceChoice,
      manualProteinType: String(sel.manualProteinType || '').trim().toLowerCase(),
      quantity: Number(sel.quantity) || 1,
      carbVegAction: sel.carbVegAction,
      carbVegConflict: sel.carbVegConflict,
      carbConflict: sel.carbConflict,
      vegConflict: sel.vegConflict,
      needsSauceChange: !!sel.needsSauceChange,
      needsGarnishChange: !!sel.needsGarnishChange,
      sauceConflict: sel.sauceConflict,
      garnishConflict: sel.garnishConflict,
      remark: String(sel.remark || '').trim(),
      exclusionConflict: Array.isArray(sel.exclusionConflict) ? sel.exclusionConflict : [],
      isAutoAssigned: !!sel.isAutoAssigned
    }));

    const record = await MenuSelectionRecord.findOneAndUpdate(
      { weeklyMenuId: menuId, ...(req.body.matterCustomerId ? { matterCustomerId: String(req.body.matterCustomerId) } : { email: safeEmailRegex }) },
      {
        $set: {
          selectedMeals: normalizedSelections,
          submittedAt: new Date(),
          email
        }
      },
      { new: true }
    );

    if (!record) return res.status(404).json({ success: false, message: 'Saved selection not found. Refresh before editing.' });
    cacheDeletePattern(`weekly-menu`);

    return res.json({ success: true, message: 'Selection updated successfully', record });
  } catch (error) {
    console.error('Error updating selection (admin override):', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export { runAssignMainMeals, runAssignSnacks, runAutoPopulateMissing, runAssignMatterCoreMeals };
export default router;
