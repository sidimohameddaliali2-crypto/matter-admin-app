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

export async function syncMenuSelectionBreakfastsToPartnerMenu(menu) {
  if (!menu.isPublished) return {created: 0, updated: 0};
  if (!menu._id) throw new Error('A saved menu is required for breakfast synchronization.');
  const menuId = String(menu._id);
  const ids = (menu.meals || []).filter(day => day.mealType === 'breakfast').flatMap(day => day.items || []).map(id => String(id?._id || id));
  const items = ids.length ? await MenuItem.find({_id: {$in: ids}, mealType: 'breakfast', isAvailable: true}).select('mealName itemDate isAvailable').lean() : [];
  const dishes = partnerBreakfastDays(menu, items);
  const retained = new Set();
  let created = 0, updated = 0;
  for (const dish of dishes) {
    const existing = await PartnerMenuItem.findOne({source: 'menu-selection', mealType: 'breakfast', name: partnerMenuNamePattern(dish.name)}).sort({_id: 1});
    const schedule = Object.fromEntries(entries(existing?.menuSelectionDatesByMenu));
    schedule[menuId] = dish.dates.map(date => new Date(date));
    const fields = {...schedulePatch(schedule), category: 'Breakfast of the day'};
    let id;
    if (existing) {
      await PartnerMenuItem.updateOne({_id: existing._id}, {$set: fields});
      id = existing._id; updated++;
    } else {
      const item = await PartnerMenuItem.create({...fields, name: dish.name, mealType: 'breakfast', source: 'menu-selection',
        price: PARTNER_BREAKFAST_DEFAULT_PRICE, sellingPrice: PARTNER_BREAKFAST_DEFAULT_PRICE, isAvailable: true});
      id = item._id; created++;
    }
    retained.add(String(id));
    await assignItemToAllActivePartners(id);
  }
  // Replace this menu's schedule, preserving dates supplied by other weeks.
  // Retain the records and IDs for historical orders and invoice snapshots.
  const previous = await PartnerMenuItem.find({source: 'menu-selection', mealType: 'breakfast', [`menuSelectionDatesByMenu.${menuId}`]: {$exists: true}}).lean();
  for (const item of previous) {
    if (retained.has(String(item._id))) continue;
    const schedule = Object.fromEntries(entries(item.menuSelectionDatesByMenu));
    delete schedule[menuId];
    await PartnerMenuItem.updateOne({_id: item._id}, {$set: schedulePatch(schedule)});
  }
  return {created, updated};
}
