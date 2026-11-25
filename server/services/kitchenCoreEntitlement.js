import Record from '../models/MenuSelectionRecord.js';
import { toBusinessDateKey } from '../utils/businessDate.js';
import { isMatterCoreDoubleDay } from '../utils/matterCoreDelivery.js';
import { dayHeld } from './kitchenMealEditPolicy.js';
import { normalizeMatterEmail } from './matterKitchenIdentity.js';
import { matchSavedKitchenInputs } from './kitchenSelectionWrite.js';

const quantity = meal => Math.max(1, Math.floor(Number(meal.quantity) || 1));
const onDate = (meal, date) => meal.date && new Date(meal.date).toISOString().slice(0, 10) === date;

export const reconcileCoreDoubleAddOns = async (record, date, nutrition, now = new Date(), { onlySnacks = false } = {}) => {
  if (!record || date < toBusinessDateKey(now) || !Array.isArray(nutrition?.active_delivery_dates)
    || !nutrition.active_delivery_dates.includes(date) || dayHeld(record, date)) return record;
  const plan = String(nutrition.plan_name || '').trim().toLowerCase();
  if (!plan) return record;
  const core = plan === 'matter core';
  const double = core && isMatterCoreDoubleDay(date, nutrition.active_delivery_dates, nutrition.double_delivery_dates);
  // An absent food-day flag cannot prove that a previously double Core date
  // is now single.
  if (core && !double && !Array.isArray(nutrition.double_delivery_dates)) return record;

  const meals = record.selectedMeals || [];
  const snacks = Number(nutrition.snacks_per_day);
  const foodDays = double ? 2 : 1;
  const updated = new Map();
  const changes = [];
  const assignedForDouble = meal => meal.isAutoAssigned === true && [1, 2].includes(meal.coreDeliveryFoodDay);
  for (const [kind, daily] of [
    ['breakfast', typeof nutrition.breakfast_included === 'boolean' ? Number(nutrition.breakfast_included) : null],
    ['snack', nutrition.snacks_per_day != null && Number.isInteger(snacks) && snacks >= 0 ? snacks : null],
  ]) {
    if (onlySnacks && kind !== 'snack') continue;
    const serving = meals.filter(meal => meal.mealType === kind && onDate(meal, date));
    const automatic = serving.filter(assignedForDouble)
      .sort((a, b) => a.coreDeliveryFoodDay - b.coreDeliveryFoodDay
        || (a.coreDeliverySnackSlot ?? 0) - (b.coreDeliverySnackSlot ?? 0));
    const saved = serving.filter(meal => !assignedForDouble(meal));
    const savedCount = saved.reduce((total, meal) => total + quantity(meal), 0);
    let remaining = daily === null ? Infinity : Math.max(0, foodDays * daily - savedCount);
    const claimedSnackSlots = new Set();
    if (kind === 'snack' && daily !== null) {
      for (const meal of saved) {
        const start = meal.slotNumber;
        if (!Number.isInteger(start) || start < 0) continue;
        for (let slot = start; slot < Math.min(start + quantity(meal), foodDays * daily); slot++) claimedSnackSlots.add(slot);
      }
    }
    for (const meal of automatic) {
      // A second-day slot is retired even if a first-day slot is empty.
      // Otherwise legacy slot inference can mistake it for a missing choice.
      let room = meal.coreDeliveryFoodDay <= foodDays ? remaining : 0;
      let slotNumber = meal.slotNumber;
      if (room > 0 && kind === 'snack' && daily !== null) {
        const start = (meal.coreDeliveryFoodDay - 1) * daily;
        const end = start + daily;
        const preferred = start + meal.coreDeliverySnackSlot;
        const available = slot => Number.isInteger(slot) && slot >= start && slot < end && !claimedSnackSlots.has(slot);
        // Keep the original position if available. A saved portion can use
        // a vacant slot on its own food day if its previous slot disappeared.
        const slot = available(preferred) ? preferred : Array.from({ length: daily }, (_, index) => start + index).find(available);
        if (slot === undefined) room = 0;
        else {
          slotNumber = slot;
          let contiguous = 0;
          while (contiguous < quantity(meal) && available(slot + contiguous)) contiguous++;
          room = Math.min(room, contiguous);
        }
      }
      const kept = Math.max(0, Math.min(room, quantity(meal)));
      remaining -= kept;
      if (kind === 'snack' && daily !== null) {
        for (let offset = 0; offset < kept; offset++) claimedSnackSlots.add(slotNumber + offset);
      }
      if (kept < quantity(meal)) changes.push(`removed ${quantity(meal) - kept} × ${meal.mealName}`);
      if (kept && slotNumber !== meal.slotNumber) changes.push(`moved ${meal.mealName} from snack slot ${meal.slotNumber} to ${slotNumber}`);
      if (kept !== quantity(meal) || slotNumber !== meal.slotNumber) {
        updated.set(meal, kept ? { ...meal, quantity: kept, slotNumber } : null);
      }
    }
  }
  if (!updated.size) return record;
  const email = normalizeMatterEmail(record.matterEmail || record.email);
  const verified = record.matterCustomerId ? String(record.matterCustomerId) === String(nutrition.customer_id)
    : (email && email === normalizeMatterEmail(nutrition.customer_email))
      || (record.matterSubscriptionId && String(record.matterSubscriptionId) === String(nutrition.subscription_id));
  if (!record._id || !verified) {
    throw new Error('Cannot reconcile Core breakfast or snacks without a verified Matter customer identity.');
  }
  const selectionIdentity = record.matterCustomerId ? { matterCustomerId: record.matterCustomerId }
    : { matterCustomerId: record.matterCustomerId ?? null, email: record.email,
      matterEmail: record.matterEmail ?? null, matterSubscriptionId: record.matterSubscriptionId ?? null };
  const selectedMeals = meals.flatMap(meal => {
    const next = updated.has(meal) ? updated.get(meal) : meal;
    return next ? [next] : [];
  });
  const result = await Record.updateOne({
    _id: record._id, ...selectionIdentity,
    'kitchenAutoHolds.date': { $ne: date },
    $expr: matchSavedKitchenInputs(record),
  }, {
    $set: { selectedMeals },
    $push: { kitchenAudit: { date, action: 'reconcile-core-double-add-ons', at: now, subscriptionId: String(nutrition.subscription_id),
      reason: `Matter plan or food-day entitlement changed: ${changes.join('; ')}` } },
  });
  if (!result.modifiedCount) throw Object.assign(new Error('Meals changed during Core breakfast and snack reconciliation. Retry preparation; customer choices were preserved.'),
    { statusCode: 409, code: 'KITCHEN_PREPARATION_BUSY' });
  return { ...record, selectedMeals };
};

// Owner (2026-11-04): old auto-assigned extras must not divide Core food
// weights into unsupported half portions. Reconcile only verified current or
// future active dates. Keep customer choices and earlier auto slots first.
export const reconcileCoreMainMeals = async (record, date, nutrition, now = new Date()) => {
  if (!record || String(nutrition?.plan_name || '').trim().toLowerCase() !== 'matter core'
    || date < toBusinessDateKey(now) || !nutrition.active_delivery_dates?.includes(date)
    || !Array.isArray(nutrition.double_delivery_dates)
    || !Number.isInteger(Number(nutrition.meal_frequency)) || Number(nutrition.meal_frequency) < 1) return record;
  const required = Number(nutrition.meal_frequency)
    * (isMatterCoreDoubleDay(date, nutrition.active_delivery_dates, nutrition.double_delivery_dates) ? 2 : 1);
  const meals = record.selectedMeals || [];
  const mains = meals.filter(meal => meal.mealType === 'main' && onDate(meal, date));
  const total = mains.reduce((sum, meal) => sum + quantity(meal), 0);
  if (total <= required) return record;
  if (!record._id || !record.matterCustomerId || String(record.matterCustomerId) !== String(nutrition.customer_id)) {
    throw new Error('Cannot reconcile Core meals without a verified Matter customer identity.');
  }
  const chosen = mains.filter(meal => meal.isAutoAssigned !== true).reduce((sum, meal) => sum + quantity(meal), 0);
  if (chosen > required) throw Object.assign(new Error(`${date}: ${nutrition.customer_name || record.email} has ${chosen} customer-selected Core meals but entitlement is ${required}. Review the selections; customer choices were preserved.`),
    { statusCode: 409, code: 'KITCHEN_CORE_SELECTION_REVIEW' });
  let remaining = required - chosen;
  const keep = new Map();
  const autos = mains.map((meal, index) => ({ meal, index })).filter(({ meal }) => meal.isAutoAssigned === true)
    .sort((a, b) => (Number(a.meal.slotNumber) || 0) - (Number(b.meal.slotNumber) || 0) || a.index - b.index);
  const removed = [];
  for (const { meal } of autos) {
    const count = Math.min(remaining, quantity(meal));
    remaining -= count;
    keep.set(meal, count);
    if (count < quantity(meal)) removed.push(`${meal.mealName}: ${quantity(meal) - count}`);
  }
  const selectedMeals = meals.flatMap(meal => {
    if (!keep.has(meal)) return [meal];
    const count = keep.get(meal);
    return count ? [count === quantity(meal) ? meal : { ...meal, quantity: count }] : [];
  });
  const result = await Record.updateOne({ _id: record._id, matterCustomerId: record.matterCustomerId,
    $expr: matchSavedKitchenInputs(record) }, {
    $set: { selectedMeals },
    $push: { kitchenAudit: { date, action: 'remove-excess-auto-core-mains', at: now,
      subscriptionId: String(nutrition.subscription_id),
      reason: `Matter meal_frequency=${nutrition.meal_frequency}, food_days=${required / Number(nutrition.meal_frequency)}; kept ${required} main portions; removed auto portions: ${removed.join('; ')}` } },
  });
  if (!result.modifiedCount) throw Object.assign(new Error('Meals changed during Core reconciliation. Retry preparation; customer choices were preserved.'),
    { statusCode: 409, code: 'KITCHEN_PREPARATION_BUSY' });
  return { ...record, selectedMeals };
};
