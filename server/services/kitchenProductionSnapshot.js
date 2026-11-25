import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import Snapshot from '../models/KitchenProductionSnapshot.js';
import Menu from '../models/WeeklyMenu.js';
import Record from '../models/MenuSelectionRecord.js';
import Archive from '../models/MenuSelectionArchive.js';
import MenuItem from '../models/MenuItem.js';
import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';
import { excludeRecreatedArchivedAliases } from './archivedMenuAliases.js';
import { assertPreparedCoverage } from './kitchenCoverage.js';
import { readKitchenSelectionWindow } from './kitchenSelectionDeadline.js';
import matterApiService from './matterApiService.js';
import { normalizeMatterAllergens } from './matterAllergens.js';
import { boundedMap } from './boundedMap.js';
import { withMenuAllergyProfiles } from './menuAllergyProfileService.js';
import { reviewSavedKitchenAllergies } from './kitchenAllergyReview.js';
import { isFallbackSnack } from './kitchenFallbackSnacks.js';
import { kitchenDietaryExclusions, usesKitchenDietaryExclusions } from './kitchenDietaryExclusions.js';

export const snapshotIsFresh = (snapshot, sourceVersion, now = Date.now()) => snapshot?.status === 'ready'
  && snapshot.sourceVersion === sourceVersion && now >= new Date(snapshot.updatedAt).getTime()
  && now - new Date(snapshot.updatedAt).getTime() < 60000;

// Production downloads check the already identified dated subscriptions.
// Ordinary preview reads keep the lightweight snapshot path.
const sortedTerms = terms => Array.isArray(terms) ? [...terms].sort() : null;
const sameTerms = (left, right) => JSON.stringify(sortedTerms(left)) === JSON.stringify(sortedTerms(right));
const datedFallback = (meal, date) => isFallbackSnack(meal) && String(meal.date instanceof Date
  ? meal.date.toISOString() : meal.date).slice(0, 10) === date;

const matterAllergiesAreCurrent = async (inputs, date, verifyExclusions) => {
  const unchanged = await boundedMap(inputs, 20, async input => {
    const subscription = (await matterApiService.getSubscription(input.subscription_id))?.data;
    const exclusions = Array.isArray(subscription?.exclusions) ? subscription.exclusions.map(item => item?.title).filter(Boolean) : null;
    const live = { plan_name: subscription?.plan?.name, exclusions };
    return subscription?.subscription_id != null && String(subscription.subscription_id) === String(input.subscription_id)
      && String(subscription.customer_id) === String(input.customer_id)
      && (subscription.delivery_schedule || []).some(day => day?.status === 'active' && String(day.date).slice(0, 10) === date)
      && sameTerms(normalizeMatterAllergens(subscription.allergens), normalizeMatterAllergens(input.allergens))
      && (!verifyExclusions || (Boolean(String(live.plan_name || '').trim()) && usesKitchenDietaryExclusions(live) === usesKitchenDietaryExclusions(input)
        && sameTerms(kitchenDietaryExclusions(live), kitchenDietaryExclusions(input))));
  });
  return unchanged.every(Boolean);
};

const sourceVersion = async menuId => {
  const menu = await Menu.findById(menuId).lean();
  if (!menu) throw Object.assign(new Error('Menu not found'), { statusCode: 404 });
  const [records, breakfast, snack, items, archives] = await Promise.all([
    Record.find({ weeklyMenuId: menuId }).select('_id updatedAt __v').sort({ _id: 1 }).lean(),
    Breakfast.findOne({ key: 'global' }).lean(), Snack.findOne({ key: 'global' }).lean(),
    MenuItem.find({ _id: { $in: (menu.meals || []).flatMap(day => day.items || []) } }).select('_id updatedAt __v').sort({ _id: 1 }).lean(),
    Archive.find({ 'original.weeklyMenuId': menuId }).select('_id createdAt updatedAt').sort({ _id: 1 }).lean(),
  ]);
  return createHash('sha256').update(JSON.stringify(['kitchen-fallback-snacks-v6', menu, records, breakfast, snack, items, archives])).digest('hex');
};

const capture = async menuId => {
  const [records, breakfast, snack] = await Promise.all([
    Record.find({ weeklyMenuId: menuId }).populate({ path: 'selectedMeals.menuItemId',
      select: '_id mealName mealType itemDate portionType rotationCategory usedForCorePlan',
      transform: (item, id) => item || id }).sort({ submittedAt: -1 }).lean(),
    Breakfast.findOne({ key: 'global' }).lean(), Snack.findOne({ key: 'global' }).lean(),
  ]);
  const aliases = records.filter(record => !record.matterCustomerId).map(record => record.email);
  const archives = aliases.length ? await Archive.find({ 'original.weeklyMenuId': menuId, 'original.email': { $in: aliases } }).lean() : [];
  return {
    kitchenSelections: excludeRecreatedArchivedAliases(records, archives),
    kitchenBreakfastPreset: { ...breakfast?.breakfastPreset, presetsByName: breakfast?.presetsByName || {} },
    kitchenSnackPreset: { presetsByName: snack?.presetsByName || {} },
  };
};

const reviewCapturedKitchenAllergies = async (menuId, date, selections, kitchenInputs, { fallbackOnly = false } = {}) => {
  const optionsByDate = new Map();
  const fallbackRows = selections.filter(row => (row.selectedMeals || []).some(meal => datedFallback(meal, date)));
  for (const nutrition of kitchenInputs) {
    const rows = !fallbackOnly && nutrition.allergyProfile?.allergies?.length ? selections : fallbackRows;
    const matches = rows.filter(row => row.matterCustomerId
      ? String(row.matterCustomerId) === String(nutrition.customer_id)
      : (nutrition.subscription_id != null && String(row.matterSubscriptionId || '') === String(nutrition.subscription_id))
        || (!!nutrition.customer_email && String(row.matterEmail || row.email || '').toLowerCase() === nutrition.customer_email.toLowerCase()));
    for (const row of matches) await reviewSavedKitchenAllergies(menuId, date,
      fallbackOnly ? { selectedMeals: row.selectedMeals.filter(isFallbackSnack) } : row, nutrition, optionsByDate);
  }
};

const readKitchenPreview = async (menuId, date, selectionWindow, { verified, reviewMessage } = {}) => {
  const [roster, inputs] = await Promise.all([
    verified?.kitchenRoster || matterApiService.findSubscriptionsWithDeliveryOnDate(date, { includeKitchenInputs: true }), capture(menuId),
  ]);
  const kitchenInputs = verified?.kitchenInputs || withMenuAllergyProfiles(roster.map(row => row.kitchen_inputs).filter(Boolean));
  let kitchenAllergyReview = reviewMessage;
  if (!kitchenAllergyReview) {
    try {
      await reviewCapturedKitchenAllergies(menuId, date, inputs.kitchenSelections, kitchenInputs);
    } catch (error) {
      if (error.code !== 'KITCHEN_ALLERGY_REVIEW') throw error;
      kitchenAllergyReview = error.message;
    }
  }
  for (const sub of roster) {
    const exists = inputs.kitchenSelections.some(row => row.matterCustomerId
      ? String(row.matterCustomerId) === String(sub.customer_id)
      : (sub.subscription_id != null && String(row.matterSubscriptionId || '') === String(sub.subscription_id))
        || (!!sub.email && String(row.matterEmail || row.email || '').toLowerCase() === String(sub.email).toLowerCase()));
    if (!exists) inputs.kitchenSelections.push({ email: sub.email, matterEmail: sub.email,
      matterCustomerId: sub.customer_id == null ? null : String(sub.customer_id), matterSubscriptionId: sub.subscription_id == null ? null : String(sub.subscription_id),
      firstName: sub.name || '', selectedMeals: [], _missingSelection: true, _missingSelectionDate: date });
  }
  return { success: true, preparation: reviewMessage ? 'allergy-review' : 'selection-open', selectionWindow,
    preparedAt: new Date().toISOString(), data: { ...inputs, kitchenRoster: roster, rosterComplete: true,
      kitchenInputs, ...(kitchenAllergyReview && { kitchenAllergyReview }) } };
};

export const readKitchenState = async (menuId, date, jobId, { refresh = false, verifyAllergies = false } = {}) => {
  const selectionWindow = await readKitchenSelectionWindow(menuId, date);
  if (!selectionWindow.canAutoAssign) {
    // Reading an open day must never run the assignment or pause-reconciliation
    // paths. Missing records are transient preview rows, never database inserts.
    return { state: 'selection-open', data: await readKitchenPreview(menuId, date, selectionWindow) };
  }
  if (jobId) {
    if (!mongoose.isValidObjectId(jobId)) throw Object.assign(new Error('Invalid preparation ID'), { statusCode: 400 });
    const job = await Snapshot.findOne({ _id: jobId, menuId, date }).lean();
    if (!job) return { state: 'missing' };
    if (job.status === 'running' && Date.now() - new Date(job.createdAt).getTime() > 300000) return { state: 'failed', message: 'Preparation expired. Retry the selected date.' };
    if (job.status === 'ready') return await verifyReadyKitchenState(job, menuId, date, verifyAllergies);
    if (job.status === 'failed' && job.payload?.preparation === 'allergy-review') {
      return { state: 'allergy-review', data: job.payload };
    }
    return { state: job.status, jobId: String(job._id), message: job.error };
  }
  const version = await sourceVersion(menuId);
  const ready = await Snapshot.findOne({ menuId, date, status: 'ready' }).sort({ createdAt: -1 }).lean();
  if (!refresh && ready) {
    const checked = await verifyReadyKitchenState(ready, menuId, date, verifyAllergies, version);
    if (checked.state === 'ready' || verifyAllergies && checked.allergyChanged) return checked;
  }
  const running = await Snapshot.findOne({ menuId, date, status: 'running', createdAt: { $gte: new Date(Date.now() - 300000) } }).sort({ createdAt: -1 }).lean();
  return running ? { state: 'running', jobId: String(running._id) } : { state: 'missing' };
};

const verifyReadyKitchenState = async (snapshot, menuId, date, verifyAllergies, version) => {
  const stale = { state: 'stale', message: 'Kitchen inputs changed or expired. Reload the selected date before exporting.' };
  const before = version ?? await sourceVersion(menuId);
  if (!snapshotIsFresh(snapshot, before)) return stale;
  const inputs = snapshot.payload?.data?.kitchenInputs || [];
  const selections = snapshot.payload?.data?.kitchenSelections || [];
  const hasFallbackSnacks = selections.some(row => (row.selectedMeals || []).some(meal => datedFallback(meal, date)));
  if (verifyAllergies && !await matterAllergiesAreCurrent(inputs, date, hasFallbackSnacks)) {
    const source = hasFallbackSnacks ? 'Matter allergies, exclusions, or delivery status' : 'Matter allergies or delivery status';
    return { state: 'stale', allergyChanged: true, message: `${source} changed. Refresh preparation before exporting.` };
  }
  try {
    if (hasFallbackSnacks) await reviewCapturedKitchenAllergies(menuId, date, selections, inputs, { fallbackOnly: true });
  } catch (error) {
    if (error.code !== 'KITCHEN_ALLERGY_REVIEW') throw error;
    return { state: 'stale', allergyChanged: true, message: error.message };
  }
  if (verifyAllergies && before !== await sourceVersion(menuId)) return stale;
  return { state: 'ready', data: snapshot.payload };
};

export const beginKitchenState = async (menuId, date, prepare, options = {}) => {
  const current = await readKitchenState(menuId, date, undefined, options);
  if (current.state !== 'missing') return current;
  const job = await Snapshot.create({ menuId, date, status: 'running', expiresAt: new Date(Date.now() + 7 * 86400000) });
  setImmediate(async () => {
    let result;
    try {
      result = await prepare();
      const before = await sourceVersion(menuId);
      const inputs = await capture(menuId);
      assertPreparedCoverage({ ...result.data, ...inputs }, date, { allowManualHolds: true });
      await reviewCapturedKitchenAllergies(menuId, date, inputs.kitchenSelections, result.data.kitchenInputs || []);
      if (before !== await sourceVersion(menuId)) throw new Error('Selections changed during preparation. Retry this date.');
      job.payload = { success: true, preparation: 'completed', preparedAt: new Date().toISOString(), snapshotId: String(job._id), data: { ...result.data, ...inputs } };
      job.sourceVersion = before;
      job.status = 'ready';
      await job.save();
    } catch (error) {
      const failure = { status: 'failed', error: error.message || 'Kitchen preparation failed' };
      if (error.code === 'KITCHEN_ALLERGY_REVIEW') {
        const message = `${failure.error} Verify the Matter allergy and the dated recipe ingredients, then refresh preparation.`;
        const preview = await readKitchenSelectionWindow(menuId, date).then(window => readKitchenPreview(menuId, date, window, {
          verified: error.kitchenAllergyInputs || result?.data, reviewMessage: message,
        })).catch(() => null);
        if (preview) failure.payload = preview;
      }
      await Snapshot.updateOne({ _id: job._id }, { $set: failure }).catch(() => {});
    }
  });
  return { state: 'running', jobId: String(job._id) };
};
