import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import Selection from '../models/MenuSelectionRecord.js';
import { FIXED_SELECTION_DEADLINES } from '../config/selectionDeadlines.js';

const fail = (message, statusCode = 400, conflicts) => {
  throw Object.assign(new Error(message), { statusCode, ...(conflicts ? { conflicts } : {}) });
};
const idOf = value => String(value?._id || value || '');
const dayKey = value => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) fail('Every menu date must be valid.');
  const key = date.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && key !== value) fail(`Invalid menu date: ${value}`);
  return key;
};
const dishKey = item => `${dayKey(item.itemDate || item.date)}|${item.mealType || 'main'}|${String(item.mealName || '').trim().toLowerCase()}`;
const customerLabel = record => [record.firstName, record.lastName].filter(Boolean).join(' ').trim() || record.matterEmail || record.email || record.matterCustomerId || 'Customer';
const normalize = value => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(key => key !== '_id').sort().map(key => [key, normalize(value[key])]));
  return value;
};

export const planManagedMenu = ({ days, existingItems = [], selections = [], startDate, endDate, published = false, bodybuilder = false, buildMealName }) => {
  if (!Array.isArray(days)) fail('Menu days must be an array.');
  const start = dayKey(startDate), end = dayKey(endDate);
  if (start > end) fail('The menu end date must be on or after the start date.');
  const byId = new Map(existingItems.map(item => [idOf(item), item]));
  const byKey = new Map();
  for (const item of existingItems) {
    const key = dishKey(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  const selectedIds = new Map(), selectedKeys = new Map();
  for (const record of selections) for (const meal of record.selectedMeals || []) {
    const label = customerLabel(record);
    const identity = idOf(meal.menuItemId);
    if (identity) selectedIds.set(identity, [...(selectedIds.get(identity) || []), label]);
    if (meal.date && meal.mealName) {
      const key = dishKey(meal);
      selectedKeys.set(key, [...(selectedKeys.get(key) || []), label]);
    }
  }
  const conflicts = [];
  const addConflict = (item, customers, action) => conflicts.push({ mealName: item.mealName, date: dayKey(item.itemDate), action, customers: [...new Set(customers)] });
  const entries = [], seen = new Set(), retained = new Set();
  for (const day of days) {
    const date = dayKey(day?.date);
    if (date < start || date > end) fail(`${date} falls outside the menu dates.`);
    if (!Array.isArray(day.items)) fail(`Items are missing for ${date}.`);
    for (const input of day.items) {
      if (!input || typeof input !== 'object') fail(`Invalid meal on ${date}.`);
      const mealType = input.mealType || 'main';
      const mealName = buildMealName(input);
      if (!mealName || !['main', 'breakfast', 'snack'].includes(mealType)) fail(`A valid meal name and type are required on ${date}.`);
      if (published && !bodybuilder && mealType === 'main' && !['chicken', 'beef', 'fish'].includes(input.portionType)) fail(`Set the protein type for ${mealName} before publishing.`);
      const fields = {
        itemDate: new Date(date), mealType, mealName, mealPlan: bodybuilder ? 'Bodybuilder' : 'Standard',
        ingredients: bodybuilder ? [['Protein', input.proteinSource], ['Vegetables', input.veg], ['Carbs', input.carbs], ['Sauces', input.sauce]].filter(([, value]) => String(value || '').trim()).map(([label, value]) => `${label}: ${String(value).trim()}`).join('; ') : input.ingredients || '',
        proteinSource: input.proteinSource || '', category: input.category || '', intolerances: input.intolerances || '',
        allergens: (Array.isArray(input.allergens) ? input.allergens : String(input.allergens || '').split(',')).map(value => String(value).trim()).filter(Boolean),
        garnish: input.garnish || '', carbs: input.carbs || '', veg: input.veg || '', sauce: input.sauce || '',
        portionType: input.portionType || '', rotationCategory: input.rotationCategory || '', usedForCorePlan: !!input.usedForCorePlan,
        ...Object.fromEntries(['portionIngredients', 'carbIngredients', 'vegIngredients', 'sauceIngredients'].map(key => [key, Array.isArray(input[key]) ? input[key] : []])),
      };
      const key = dishKey(fields);
      if (seen.has(key)) fail(`Duplicate menu dish on ${date}: ${mealName}. Use selection quantity for double portions.`);
      seen.add(key);
      const suppliedId = idOf(input.menuItemId);
      if (suppliedId && !byId.has(suppliedId)) fail(`Meal ${mealName} does not belong to this menu. Reload before saving.`, 409);
      const existing = suppliedId ? byId.get(suppliedId) : byKey.get(key);
      const changed = existing && Object.entries(fields).some(([field, value]) => JSON.stringify(normalize(existing[field] ?? (Array.isArray(value) ? [] : typeof value === 'boolean' ? false : ''))) !== JSON.stringify(normalize(value)));
      if (existing) {
        const customers = [...(selectedIds.get(idOf(existing)) || []), ...(selectedKeys.get(dishKey(existing)) || [])];
        if (changed && customers.length) addConflict(existing, customers, 'change');
        if (!changed) retained.add(idOf(existing));
      }
      entries.push({ fields, existingId: existing && !changed ? existing._id : null, previous: existing || null });
      if (entries.length > 5000) fail('A menu may contain at most 5000 dishes.');
    }
  }
  for (const item of existingItems) if (!retained.has(idOf(item))) {
    const customers = [...(selectedIds.get(idOf(item)) || []), ...(selectedKeys.get(dishKey(item)) || [])];
    if (customers.length && !conflicts.some(conflict => conflict.date === dayKey(item.itemDate) && conflict.mealName === item.mealName)) addConflict(item, customers, 'remove');
  }
  if (conflicts.length) fail(`Existing customer selections are protected. Cannot ${conflicts[0].action} ${conflicts[0].mealName} (${conflicts[0].date}); selected by ${conflicts[0].customers.slice(0, 3).join(', ')}. Keep selected dishes unchanged or resolve their selections separately.`, 409, conflicts);
  if (published && !entries.length) fail('Add meals before publishing the menu.');
  return entries;
};

export const saveManagedMenu = async ({ menuId, body, userId, buildMealName, mergeUploadedSnackPools }) => {
  let saved;
  await mongoose.connection.transaction(async session => {
    const menu = menuId ? await Menu.findById(menuId).session(session) : new Menu({ createdBy: userId, meals: [], mealPlans: ['Standard'], shareLink: { token: crypto.randomBytes(32).toString('hex'), createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86400000), isActive: true } });
    if (!menu) fail('Menu not found', 404);
    if (menuId && body.expectedUpdatedAt !== undefined && (!menu.updatedAt || new Date(body.expectedUpdatedAt).getTime() !== new Date(menu.updatedAt).getTime())) fail('This menu changed since you opened it. Reload the menu before saving.', 409);
    const oldItems = (menu.meals || []).flatMap(day => day.items || []).map(idOf);
    const selections = menuId ? await Selection.find({ weeklyMenuId: menuId }).session(session).lean() : [];
    const previousStart = menuId ? dayKey(menu.startDate) : null;
    const previousEnd = menuId ? dayKey(menu.endDate) : null;
    for (const field of ['title', 'description', 'startDate', 'endDate', 'mealPlans', 'isPublished', 'enableCompletionMessage', 'completionMessage', 'breakfastPreset', 'breakfastPresetsByName']) if (body[field] !== undefined) menu.set(field, body[field]);
    const start = dayKey(menu.startDate), end = dayKey(menu.endDate);
    if (start > end) fail('The menu end date must be on or after the start date.');
    // Historical out-of-week rows must not prevent an unchanged menu from saving.
    // Reject only a boundary change that newly excludes a previously covered meal.
    for (const record of selections.filter(record => idOf(record.weeklyMenuId) === idOf(menu._id))) for (const meal of record.selectedMeals || []) {
      if (!meal.date) continue;
      const date = dayKey(meal.date);
      if (date >= previousStart && date <= previousEnd && (date < start || date > end)) fail(`Menu dates would exclude ${customerLabel(record)}'s selection on ${date}.`, 409);
    }
    menu.selectionDeadlines = FIXED_SELECTION_DEADLINES;
    if (body.shareLinkActive !== undefined) {
      if (!menu.shareLink?.token) menu.shareLink = { token: crypto.randomBytes(32).toString('hex'), createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86400000) };
      menu.shareLink.isActive = !!body.shareLinkActive;
    }
    const existingItems = oldItems.length ? await Item.find({ _id: { $in: oldItems } }).session(session).lean() : [];
    let days = body.days;
    if (days === undefined && body.meals !== undefined) {
      if (!Array.isArray(body.meals)) fail('Menu meals must be an array.');
      const refs = body.meals.flatMap(day => day.items || []).map(idOf);
      const linked = refs.length ? await Item.find({ _id: { $in: refs } }).session(session).lean() : [];
      days = body.meals.map(day => ({ date: day.date, items: (day.items || []).map(ref => {
        const item = linked.find(candidate => idOf(candidate) === idOf(ref));
        if (!item || dayKey(item.itemDate) !== dayKey(day.date) || item.mealType !== day.mealType) fail('Menu item references do not match their date and meal type.');
        return { ...item, ...(oldItems.includes(idOf(ref)) ? { menuItemId: idOf(ref) } : {}) };
      }) }));
    }
    if (days !== undefined) {
      const entries = planManagedMenu({ days, existingItems, selections, startDate: menu.startDate, endDate: menu.endDate, published: menu.isPublished, bodybuilder: body.bodybuilderMode === true || (menu.mealPlans || []).includes('Bodybuilder'), buildMealName });
      const grouped = new Map();
      for (const entry of entries) {
        let itemId = entry.existingId;
        if (!itemId) {
          const fields = { ...entry.previous, ...entry.fields };
          for (const field of ['_id', '__v', 'createdAt', 'updatedAt']) delete fields[field];
          const item = new Item(fields);
          await item.save({ session });
          itemId = item._id;
        }
        const key = `${dayKey(entry.fields.itemDate)}|${entry.fields.mealType}`;
        if (!grouped.has(key)) grouped.set(key, { date: entry.fields.itemDate, mealType: entry.fields.mealType, items: [] });
        grouped.get(key).items.push(itemId);
      }
      menu.meals = [...grouped.values()];
      mergeUploadedSnackPools(menu, days);
    } else if (body.isPublished === true) {
      if (!existingItems.length) fail('Add meals before publishing the menu.');
      if (!(menu.mealPlans || []).includes('Bodybuilder')) for (const item of existingItems) if (item.mealType === 'main' && !['chicken', 'beef', 'fish'].includes(item.portionType)) fail(`Set the protein type for ${item.mealName} before publishing.`);
    }
    await menu.save({ session });
    saved = menu;
  });
  return saved;
};
