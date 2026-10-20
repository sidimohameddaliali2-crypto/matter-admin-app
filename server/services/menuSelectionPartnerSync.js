import PartnerMenuItem from '../models/PartnerMenuItem.js';
import MenuItem from '../models/MenuItem.js';
import Partner from '../models/Partner.js';
import SpaceMenu from '../models/SpaceMenu.js';

// Owner (2026-10-19): the kitchen's daily chicken/beef/fish main-meal rotation
// in the customer Menu Selection should also be orderable by partners from the
// master menu, at these fixed prices per protein type (not per dish).
const PROTEIN_PRICING = {
  chicken: { price: 7, sellingPrice: 35 },
  beef: { price: 11, sellingPrice: 40 },
  fish: { price: 13, sellingPrice: 40 },
};

// Makes one master-menu item orderable by every active partner (upsert into
// SpaceMenu, their sub-menu assignment table). Idempotent — safe to re-run.
// No SpacePrice is written, so each partner sees the fixed sellingPrice above
// unless they already have their own per-partner price override.
const assignItemToAllActivePartners = async (menuItemId) => {
  const partners = await Partner.find({ isActive: true }).select('_id').lean();
  await Promise.all(partners.map((p) =>
    SpaceMenu.findOneAndUpdate(
      { space: p._id, menuItem: menuItemId },
      { $set: { isActive: true } },
      { upsert: true }
    )
  ));
};

// Gives one partner (typically a newly created one) every menu-selection-
// sourced item that already exists, so they aren't missing the chicken/beef/
// fish rotation just because they signed up after the last sync ran. Call
// this from wherever a Partner is created (see routes/adminPartners.js).
export const assignMenuSelectionItemsToPartner = async (partnerId) => {
  const items = await PartnerMenuItem.find({ source: 'menu-selection' }).select('_id').lean();
  await Promise.all(items.map((it) =>
    SpaceMenu.findOneAndUpdate(
      { space: partnerId, menuItem: it._id },
      { $set: { isActive: true } },
      { upsert: true }
    )
  ));
};

/**
 * Mirrors a WeeklyMenu's chicken/beef/fish main meals into the partner master
 * menu (PartnerMenuItem), so they stay orderable by partners for exactly the
 * day(s) the kitchen is actually serving them that week.
 *
 * Called whenever a WeeklyMenu is saved in a published state (see
 * routes/menus.js PUT /:id) — "always use the menu for next week" means this
 * runs on every publish/edit-of-a-published-menu, not just once. A dish name
 * that repeats across several days (same week or a later week) has its
 * master-menu availability window widened to cover all of them; a dish that
 * never repeats keeps a single-day window and simply stops being orderable
 * once that day passes — nothing deletes it, the date just expires.
 *
 * Matching is by exact mealName (the kitchen types these consistently in
 * caps), scoped to mealType 'main' — deliberately simple, not fuzzy.
 *
 * Every item this creates/updates is also assigned to every active partner
 * (SpaceMenu), so it's immediately orderable without a manual Space Setup
 * step — see assignItemToAllActivePartners below.
 *
 * @param {import('../models/WeeklyMenu.js').default} weeklyMenu - a saved WeeklyMenu document
 * @returns {Promise<{created: number, updated: number}>}
 */
export const syncMenuSelectionMainMealsToPartnerMenu = async (weeklyMenu) => {
  const mainDays = (weeklyMenu.meals || []).filter((m) => m.mealType === 'main');
  const itemIds = mainDays.flatMap((m) => m.items || []).map(String);
  if (!itemIds.length) return { created: 0, updated: 0 };

  const items = await MenuItem.find({
    _id: { $in: itemIds },
    portionType: { $in: Object.keys(PROTEIN_PRICING) },
    isAvailable: true,
  }).select('mealName portionType itemDate').lean();

  // Group by dish name so a dish appearing on several days in this same
  // save gets one widened window instead of one row per occurrence.
  const byName = new Map(); // lowercase name -> { name, portionType, dates: Date[] }
  items.forEach((item) => {
    const name = (item.mealName || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name, portionType: item.portionType, dates: [] });
    byName.get(key).dates.push(item.itemDate);
  });

  let created = 0;
  let updated = 0;
  for (const { name, portionType, dates } of byName.values()) {
    const pricing = PROTEIN_PRICING[portionType];
    if (!pricing) continue;
    const from = new Date(Math.min(...dates.map((d) => new Date(d).getTime())));
    const to = new Date(Math.max(...dates.map((d) => new Date(d).getTime())));

    const existing = await PartnerMenuItem.findOne({ name, mealType: 'main' });
    let itemId;
    if (existing) {
      // Widen the window — never narrow it, in case this save only touched
      // some of the days this dish has previously synced on.
      const nextFrom = existing.availableFrom && existing.availableFrom < from ? existing.availableFrom : from;
      const nextTo = existing.availableTo && existing.availableTo > to ? existing.availableTo : to;
      await PartnerMenuItem.updateOne(
        { _id: existing._id },
        { $set: { availableFrom: nextFrom, availableTo: nextTo, price: pricing.price, sellingPrice: pricing.sellingPrice, isAvailable: true, source: 'menu-selection' } }
      );
      itemId = existing._id;
      updated += 1;
    } else {
      const doc = await PartnerMenuItem.create({
        name,
        mealType: 'main',
        price: pricing.price,
        sellingPrice: pricing.sellingPrice,
        availableFrom: from,
        availableTo: to,
        isAvailable: true,
        source: 'menu-selection',
      });
      itemId = doc._id;
      created += 1;
    }
    // Every partner should be able to order this without a manual Space Setup step.
    await assignItemToAllActivePartners(itemId);
  }
  return { created, updated };
};
