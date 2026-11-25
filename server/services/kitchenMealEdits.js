import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import Record from '../models/MenuSelectionRecord.js';
import Log from '../models/KitchenMealEditLog.js';
import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';
import matter from './matterApiService.js';
import { matterSelectionFilter, matterSelectionIdentity } from './matterKitchenIdentity.js';
import { kitchenSelectionWindow } from './kitchenSelectionDeadline.js';
import { assertMealEditsOpen, planMealEdit, dayHeld } from './kitchenMealEditPolicy.js';
import { isDateKey, toBusinessDateKey } from '../utils/businessDate.js';
import { toKitchenOption, kitchenConflictList } from './kitchenExclusions.js';
import { assertAssignmentMacros, hasKitchenPreset } from './kitchenMacroValidation.js';
import { isMatterCoreDoubleDay } from '../utils/matterCoreDelivery.js';
import { validatedMenuSelections } from './menuSelectionValidation.js';

const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const onDate = (meal, date) => new Date(meal.date).toISOString().slice(0, 10) === date;
export const mealEditToken = record => record ? createHash('sha256').update(JSON.stringify([
  String(record._id), record.updatedAt || null, record.selectedMeals || [], record.kitchenAutoHolds || [], record.kitchenEditRevision || 0,
])).digest('hex') : 'missing';
const validateScope = (menuId, customerId, date) => {
  if (!mongoose.isValidObjectId(menuId) || !/^[1-9]\d*$/.test(customerId || '') || !isDateKey(date)) fail('Select a valid menu, Matter customer ID and delivery date.', 400);
};
const recordFor = async (menuId, nutrition, session) => {
  let query = Record.find(matterSelectionFilter(menuId, nutrition));
  if (session) query = query.session(session);
  const rows = await query.lean();
  if (rows.length > 1) fail('Multiple selections match this Matter customer. Resolve the duplicate first.');
  return rows[0] || null;
};
const validDate = (menu, date) => {
  if (!menu || date < new Date(menu.startDate).toISOString().slice(0, 10) || date > new Date(menu.endDate).toISOString().slice(0, 10)) fail('This date is outside the selected menu.', 400);
};
export const readMealEditContext = async (menuId, customerId, date) => {
  validateScope(menuId, customerId, date);
  const menu = await Menu.findById(menuId).lean();
  validDate(menu, date);
  const window = kitchenSelectionWindow(menu, date);
  const nutrition = await matter.getKitchenNutrition({ customerId, date });
  if (String(nutrition?.customer_id) !== customerId || !nutrition.active_delivery_dates?.includes(date)) fail('Matter does not confirm an active delivery for this customer/date.');
  if (!String(nutrition.plan_name || '').trim()) fail('Matter plan identity is unresolved. Verify the subscription before editing meals.');
  const record = await recordFor(menuId, nutrition);
  if ((record?.skippedDays || []).some(day => day.date === date && !day.resumedAt)) fail('Resolve the saved delivery pause before editing meals.');
  const items = await Item.find({ _id: { $in: (menu.meals || []).flatMap(day => day.items || []) }, itemDate: new Date(date) }).lean();
  const [breakfast, snack] = await Promise.all([
    items.some(item => item.mealType === 'breakfast') ? Breakfast.findOne({ key: 'global' }).lean() : null,
    items.some(item => item.mealType === 'snack') ? Snack.findOne({ key: 'global' }).lean() : null,
  ]);
  const core = String(nutrition.plan_name || '').trim().toLowerCase() === 'matter core';
  const choices = items.filter(item => !core || item.mealType !== 'main' || item.usedForCorePlan === true).map(item => ({
    id: String(item._id), name: item.mealName, mealType: item.mealType,
    conflicts: kitchenConflictList(toKitchenOption(item), nutrition.exclusions || []),
    hasMacros: item.mealType === 'main' || hasKitchenPreset(item.mealName, (item.mealType === 'snack' ? snack : breakfast)?.presetsByName),
  }));
  return { menu, nutrition, record, items, choices, window };
};
export const mealEditView = context => ({
  meals: (context.record?.selectedMeals || []).filter(meal => onDate(meal, context.window.date)),
  choices: context.choices, token: mealEditToken(context.record),
  automaticAssignmentPaused: dayHeld(context.record, context.window.date),
  lastEdit: context.record?.kitchenLastMealEdit || null,
  canEdit: !context.window.canAutoAssign, deadlineAt: context.window.deadlineAt,
});

export const editKitchenMeals = async ({ menuId, customerId, date, body, user }) => {
  validateScope(menuId, customerId, date);
  if (!['add', 'change', 'delete', 'restore'].includes(body.action)) fail('Choose a valid action.', 400);
  // Check the cutoff before contacting Matter, and again immediately before writes.
  const header = await Menu.findById(menuId).lean(); validDate(header, date);
  if (body.action !== 'restore') assertMealEditsOpen(header, date);
  if (date < toBusinessDateKey(new Date())) fail('Historical meal assignments cannot be edited.');
  const context = await readMealEditContext(menuId, customerId, date);
  const actor = { id: String(user._id), name: [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ').trim() || user.email || String(user._id) };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > 500) fail('Keep the reason within 500 characters.', 400);
  let replacement;
  if (['add', 'change'].includes(body.action)) {
    const item = context.items.find(item => String(item._id) === body.menuItemId);
    if (!item || !context.choices.some(choice => choice.id === body.menuItemId)) fail('Choose a dish from this date’s eligible menu. Core mains must be Core-tagged.');
    const conflicts = kitchenConflictList(toKitchenOption(item), context.nutrition.exclusions || []);
    if (conflicts.length) fail(`This dish conflicts with customer exclusions: ${conflicts.join(', ')}.`);
    replacement = { menuItemId: item._id, mealType: item.mealType, mealName: item.mealName };
    await assertAssignmentMacros([replacement]);
    // The staff editor is also a selection write path. Reuse the canonical
    // allergy/profile validation rather than trusting Matter exclusions alone.
    // Validate only the newly added/replaced portions; existing unsafe choices
    // must still be removable, and unrelated saved rows stay untouched.
    [replacement] = await validatedMenuSelections({ menuId, nutrition: context.nutrition,
      selections: [{ ...replacement, date, quantity: body.quantity ?? 1 }] });
  }
  let saved;
  await mongoose.connection.transaction(async session => {
    const menu = await Menu.findById(menuId).session(session).lean(); validDate(menu, date);
    const record = await recordFor(menuId, context.nutrition, session);
    if (typeof body.token !== 'string' || body.token !== mealEditToken(record)) fail('Selections changed since you opened the editor. Reload before saving.');
    if (replacement) {
      if (!(menu.meals || []).flatMap(day => day.items || []).some(id => String(id) === String(replacement.menuItemId))) fail('Menu dishes changed. Reload before saving.');
      const current = await Item.findById(replacement.menuItemId).session(session).lean();
      const prior = context.items.find(item => String(item._id) === String(replacement.menuItemId));
      if (!current || JSON.stringify(current) !== JSON.stringify(prior)) fail('The selected dish changed during editing. Reload before saving.');
    }
    const planned = planMealEdit({ record, action: body.action, mealId: body.mealId, quantity: body.quantity,
      replacement, date, actor });
    if (String(context.nutrition.plan_name).trim().toLowerCase() === 'matter core' && ['add', 'change'].includes(body.action)) {
      const frequency = Number(context.nutrition.meal_frequency);
      if (!Number.isInteger(frequency) || frequency < 1) fail('Matter Core meal frequency is unresolved.');
      const required = frequency * (isMatterCoreDoubleDay(date, context.nutrition.active_delivery_dates, context.nutrition.double_delivery_dates) ? 2 : 1);
      const count = meals => (meals || []).filter(meal => meal.mealType === 'main' && onDate(meal, date))
        .reduce((sum, meal) => sum + Math.max(1, Math.floor(Number(meal.quantity) || 1)), 0);
      if (count(planned.selectedMeals) > Math.max(required, count(record?.selectedMeals))) fail(`Matter Core entitlement is ${required} main meal portion(s) for ${date}. Adding excess portions would block production.`);
    }
    const now = new Date();
    if (body.action !== 'restore') assertMealEditsOpen(menu, date, now);
    const last = { action: body.action, date, at: now, actorName: actor.name, summary: planned.summary };
    const values = { selectedMeals: planned.selectedMeals, kitchenAutoHolds: planned.kitchenAutoHolds, kitchenLastMealEdit: last,
      matterCustomerId: customerId, matterEmail: context.nutrition.customer_email,
      matterSubscriptionId: String(context.nutrition.subscription_id || '') };
    if (record) {
      const updated = await Record.updateOne({ _id: record._id, selectedMeals: record.selectedMeals,
        updatedAt: record.updatedAt || { $exists: false },
        $expr: { $eq: [{ $ifNull: ['$kitchenAutoHolds', []] }, record.kitchenAutoHolds || []] } },
      { $set: values, $inc: { kitchenEditRevision: 1 } }, { session });
      if (!updated.matchedCount) fail('Selections changed while saving. Reload before editing.');
    } else {
      if (body.action !== 'add') fail('No saved selection exists.');
      const identity = matterSelectionIdentity(context.nutrition);
      await Record.create([{ weeklyMenuId: menuId, ...identity, email: identity.matterEmail, ...values, kitchenEditRevision: 1 }], { session });
    }
    await Log.create([{ menuId, customerId, date, ...last, actorId: actor.id, before: planned.before, after: planned.after,
      quantity: body.quantity || 1, reason }], { session });
    saved = last;
  });
  return { lastEdit: saved, message: body.action === 'restore' ? 'Automatic assignment restored. It can fill missing portions after the menu deadline.' : saved.summary };
};

export const readMealEditLog = async ({ menuId, customerId, before }) => {
  if (!mongoose.isValidObjectId(menuId) || !/^[1-9]\d*$/.test(customerId || '') || (before && !mongoose.isValidObjectId(before))) fail('Invalid history request.', 400);
  const rows = await Log.find({ menuId, customerId, ...(before ? { _id: { $lt: before } } : {}) }).sort({ _id: -1 }).limit(31).lean();
  return { entries: rows.slice(0, 30), next: rows.length > 30 ? String(rows[29]._id) : null };
};
