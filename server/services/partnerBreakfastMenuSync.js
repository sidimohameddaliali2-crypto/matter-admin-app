import PartnerMenuItem from '../models/PartnerMenuItem.js';
import MenuItem from '../models/MenuItem.js';
import { assignItemToAllActivePartners } from './partnerMenuAssignment.js';
import { partnerMenuNameKey, partnerMenuNamePattern } from './partnerMenuCatalog.js';

// Owner (2026-11-17): default AED 20, editable in Master Menu. Existing prices
// are never overwritten by a later menu publish or rotation edit.
export const PARTNER_BREAKFAST_DEFAULT_PRICE = 20;
const entries = value => value instanceof Map ? [...value.entries()] : Object.entries(value || {});
const dateKey = value => {
  const date = value ? new Date(value) : new Date(NaN);
  if (!Number.isFinite(+date)) return null;
  const key = date.toISOString().slice(0, 10);
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && key !== value ? null : key;
};

export function partnerBreakfastDays(menu, items) {
  const byId = new Map(items.filter(item => item.isAvailable !== false).map(item => [String(item._id), item]));
  const byDate = new Map();
  for (const day of menu.meals || []) {
    if (day.mealType !== 'breakfast') continue;
    const date = dateKey(day.date);
    if (!date) continue;
    const names = (day.items || []).map(id => byId.get(String(id?._id || id))?.mealName).filter(Boolean);
    byDate.set(date, [...(byDate.get(date) || []), ...names]);
  }
  for (const [date, options] of entries(menu.breakfastOptionsByDate)) {
    if (dateKey(date) && Array.isArray(options) && options.length) byDate.set(date, options.map(option => option.name));
  }
  const dishes = new Map();
  const start = dateKey(menu.startDate), end = dateKey(menu.endDate);
  for (const [date, names] of byDate) {
    if ((start && date < start) || (end && date > end)) continue;
    for (const value of names) {
      const name = String(value || '').trim().replace(/\s+/g, ' ');
      if (!name) continue;
      const key = partnerMenuNameKey(name);
      if (!dishes.has(key)) dishes.set(key, {name, dates: new Set()});
      dishes.get(key).dates.add(date);
    }
  }
  return [...dishes.values()].map(dish => ({name: dish.name, dates: [...dish.dates].sort()}));
}

const schedulePatch = schedule => {
  const dates = [...new Set(Object.values(schedule).flat().map(dateKey).filter(Boolean))].sort();
  return {menuSelectionDatesByMenu: schedule, availableDates: dates.map(date => new Date(date)),
    availableFrom: dates.length ? new Date(dates[0]) : null, availableTo: dates.length ? new Date(dates.at(-1)) : null};
};

// Optimistic updates work across PM2 processes. Every successful writer
// increments the revision, so a stale snapshot cannot replace newer dates.
async function updateSchedule(id, menuId, dates, syncKey) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const item = await PartnerMenuItem.findById(id).lean();
    if (!item) throw new Error('The breakfast item changed during synchronization. Please retry.');
    const schedule = Object.fromEntries(entries(item.menuSelectionDatesByMenu));
    if (dates === null) {
      if (!Object.hasOwn(schedule, menuId)) return false;
      delete schedule[menuId];
    } else schedule[menuId] = dates.map(date => new Date(date));
    const fields = {...schedulePatch(schedule), category: 'Breakfast of the day'};
    if (syncKey !== undefined) fields.breakfastSyncKey = syncKey;
    const revision = item.breakfastScheduleRevision;
    const result = await PartnerMenuItem.updateOne({ _id: id,
      breakfastScheduleRevision: revision === undefined ? { $exists: false } : revision },
      { $set: fields, $inc: { breakfastScheduleRevision: 1 } });
    if (result.matchedCount === 1) return true;
  }
  throw new Error('Breakfast dates changed repeatedly during synchronization. Please retry saving the menu.');
}

const canonicalBreakfast = key => PartnerMenuItem.findOne({source: 'menu-selection', mealType: 'breakfast', breakfastSyncKey: key});

export async function syncMenuSelectionBreakfastsToPartnerMenu(menu) {
  if (!menu._id) throw new Error('A saved menu is required for breakfast synchronization.');
  const menuId = String(menu._id);
  const ids = menu.isPublished ? (menu.meals || []).filter(day => day.mealType === 'breakfast').flatMap(day => day.items || []).map(id => String(id?._id || id)) : [];
  const items = ids.length ? await MenuItem.find({_id: {$in: ids}, mealType: 'breakfast', isAvailable: true}).select('mealName itemDate isAvailable').lean() : [];
  const dishes = menu.isPublished ? partnerBreakfastDays(menu, items) : [];
  const retained = new Set();
  let created = 0, updated = 0;
  // Wait for the unique index before any first-publication create race.
  if (dishes.length) await PartnerMenuItem.init();
  for (const dish of dishes) {
    const key = partnerMenuNameKey(dish.name);
    let existing = await canonicalBreakfast(key);
    if (!existing) existing = await PartnerMenuItem.findOne({source: 'menu-selection', mealType: 'breakfast',
      breakfastSyncKey: { $exists: false }, name: partnerMenuNamePattern(dish.name)}).sort({_id: 1});
    let id = existing?._id;
    if (!id) {
      try {
        const item = await PartnerMenuItem.create({name: dish.name, mealType: 'breakfast', source: 'menu-selection',
          category: 'Breakfast of the day', breakfastSyncKey: key, breakfastScheduleRevision: 0,
          menuSelectionDatesByMenu: {}, availableDates: [],
          price: PARTNER_BREAKFAST_DEFAULT_PRICE, sellingPrice: PARTNER_BREAKFAST_DEFAULT_PRICE, isAvailable: true});
        id = item._id; created++;
      } catch (error) {
        if (error.code !== 11000) throw error;
        // Another publisher created this dish after our lookup.
        const winner = await canonicalBreakfast(key);
        if (!winner) throw error;
        id = winner._id; updated++;
      }
    } else updated++;
    try { await updateSchedule(id, menuId, dish.dates, key); }
    catch (error) {
      if (error.code !== 11000) throw error;
      // Two workers may also race to adopt pre-existing casing duplicates.
      const winner = await canonicalBreakfast(key);
      if (!winner) throw error;
      id = winner._id;
      await updateSchedule(id, menuId, dish.dates, key);
    }
    retained.add(String(id));
    await assignItemToAllActivePartners(id);
  }
  // Withdrawal and removed options clear only this menu's contribution. The
  // same revision check protects dates concurrently supplied by other menus.
  const previous = await PartnerMenuItem.find({source: 'menu-selection', mealType: 'breakfast', [`menuSelectionDatesByMenu.${menuId}`]: {$exists: true}}).lean();
  for (const item of previous) {
    if (retained.has(String(item._id))) continue;
    if (await updateSchedule(item._id, menuId, null)) updated++;
  }
  return {created, updated};
}
