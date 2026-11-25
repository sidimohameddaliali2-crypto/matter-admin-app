import mongoose from 'mongoose';
import Record from '../models/MenuSelectionRecord.js';
import matterApiService, { buildNutritionResult } from './matterApiService.js';
import { withMenuAllergyProfiles } from './menuAllergyProfileService.js';
import { collectSavedKitchenAllergies, matchesKitchenAllergyRecord } from './kitchenAllergyReview.js';

const changed = () => Object.assign(new Error('The meal or Matter allergy information changed. Refresh Kitchen List before confirming.'), { statusCode: 409 });

export async function confirmKitchenAllergy({ menuId, customerId, body, user }) {
  const { recordId, mealId, subscriptionId, date, fingerprint } = body;
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (![menuId, recordId, mealId].every(id => typeof id === 'string' && mongoose.isValidObjectId(id))
    || ![customerId, subscriptionId].every(id => typeof id === 'string' && /^[1-9]\d*$/.test(id))
    || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)
    || !note || note.length > 500) {
    throw Object.assign(new Error('Select an allergy case and describe how the kitchen will handle the allergen in 500 characters or fewer.'), { statusCode: 400 });
  }

  const filter = { _id: recordId, weeklyMenuId: menuId, 'selectedMeals._id': mealId };
  const record = await Record.findOne(filter).select('+kitchenAllergyConfirmations').lean();
  if (!record) throw changed();
  const subscription = (await matterApiService.getSubscription(subscriptionId))?.data;
  if (String(subscription?.customer_id) !== customerId || String(subscription?.subscription_id) !== subscriptionId) throw changed();
  const [nutrition] = withMenuAllergyProfiles([buildNutritionResult(subscription)]);
  if (!nutrition.allergyProfile.allergiesAvailable || !nutrition.active_delivery_dates?.includes(date)
    || !matchesKitchenAllergyRecord(record, nutrition)) throw changed();

  const meal = record.selectedMeals.find(item => String(item._id) === mealId);
  if (!meal) throw changed();
  const findings = await collectSavedKitchenAllergies(menuId, date, { ...record, selectedMeals: [meal] }, nutrition, new Map());
  const finding = findings.find(item => item.canConfirm && item.fingerprint === fingerprint);
  if (!finding) throw changed();
  if (finding.confirmation) return finding.confirmation;

  const actorName = [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ').trim() || user.email || String(user._id);
  const confirmation = { actorName, at: new Date(), note };
  const write = await Record.updateOne({ ...filter, updatedAt: record.updatedAt ?? null,
    'kitchenAllergyConfirmations.fingerprint': { $ne: fingerprint } },
  { $push: { kitchenAllergyConfirmations: { ...confirmation, fingerprint, mealId, mealName: finding.mealName,
    date, subscriptionId, conflicts: finding.conflicts, actorId: String(user._id) } } });
  if (write.modifiedCount !== 1) throw changed();
  return confirmation;
}
