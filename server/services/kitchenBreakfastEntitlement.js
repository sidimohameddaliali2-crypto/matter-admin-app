import Record from '../models/MenuSelectionRecord.js';
import { toBusinessDateKey } from '../utils/businessDate.js';

// Reconcile obsolete kitchen-generated extras only. Never remove a customer's
// breakfast choice, another date's food, or anything based on missing inputs.
export const reconcileCoreBreakfast = async (record, date, nutrition, now = new Date()) => {
  if (!record || nutrition?.breakfast_included !== false
    || String(nutrition.plan_name || '').trim().toLowerCase() !== 'matter core') return record;
  // Current subscription terms cannot prove an old day's breakfast entitlement.
  if (date < toBusinessDateKey(now) || !Array.isArray(nutrition.active_delivery_dates)
    || !nutrition.active_delivery_dates.includes(date)) return record;
  const removed = (record.selectedMeals || []).filter(meal => meal.mealType === 'breakfast' && meal.isAutoAssigned === true
    && meal.date && new Date(meal.date).toISOString().slice(0, 10) === date);
  if (!removed.length) return record;
  if (!record._id || (record.matterCustomerId && String(record.matterCustomerId) !== String(nutrition.customer_id))) {
    throw new Error('Cannot reconcile breakfast without a verified selection identity.');
  }
  const selectedMeals = record.selectedMeals.filter(meal => !removed.includes(meal));
  const result = await Record.updateOne({ _id: record._id, selectedMeals: record.selectedMeals,
    $expr: { $eq: [{ $ifNull: ['$skippedDays', []] }, record.skippedDays || []] } }, {
    $set: { selectedMeals },
    $push: { kitchenAudit: { date, action: 'remove-unentitled-auto-breakfast', at: new Date(),
      subscriptionId: String(nutrition.subscription_id), reason: `Matter breakfast_included=false; removed only auto-assigned breakfast: ${removed.map(meal => meal.mealName).join(', ')}` } },
  });
  if (!result.modifiedCount) throw Object.assign(new Error('Meals changed during breakfast reconciliation. Retry preparation; customer choices were preserved.'),
    { statusCode: 409, code: 'KITCHEN_PREPARATION_BUSY' });
  return { ...record, selectedMeals };
};
