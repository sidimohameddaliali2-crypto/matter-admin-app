import Record from '../models/MenuSelectionRecord.js';
import { toBusinessDateKey } from '../utils/businessDate.js';
import { isMatterCoreDoubleDay } from '../utils/matterCoreDelivery.js';

const quantity = meal => Math.max(1, Math.floor(Number(meal.quantity) || 1));
const onDate = (meal, date) => meal.date && new Date(meal.date).toISOString().slice(0, 10) === date;

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
    selectedMeals: meals, $expr: { $eq: [{ $ifNull: ['$skippedDays', []] }, record.skippedDays || []] } }, {
    $set: { selectedMeals },
    $push: { kitchenAudit: { date, action: 'remove-excess-auto-core-mains', at: now,
      subscriptionId: String(nutrition.subscription_id),
      reason: `Matter meal_frequency=${nutrition.meal_frequency}, food_days=${required / Number(nutrition.meal_frequency)}; kept ${required} main portions; removed auto portions: ${removed.join('; ')}` } },
  });
  if (!result.modifiedCount) throw Object.assign(new Error('Meals changed during Core reconciliation. Retry preparation; customer choices were preserved.'),
    { statusCode: 409, code: 'KITCHEN_PREPARATION_BUSY' });
  return { ...record, selectedMeals };
};
