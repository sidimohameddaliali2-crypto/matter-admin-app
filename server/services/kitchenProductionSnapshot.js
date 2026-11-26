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
import matterApiService, { buildNutritionResult } from './matterApiService.js';
import { menuNutritionForDate } from './menuPlanSchedule.js';
import { normalizeMatterAllergens } from './matterAllergens.js';
import { boundedMap } from './boundedMap.js';
import { withMenuAllergyProfiles } from './menuAllergyProfileService.js';
import { collectSavedKitchenAllergies, matchesKitchenAllergyRecord } from './kitchenAllergyReview.js';
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
    // Scheduled standalone details can be unavailable. Read the verified
    // parent when known, then resolve the applicable plan on this food date.
    const live = input.is_upcoming_plan && !input.source_parent_subscription_id
      ? await matterApiService.getKitchenNutrition({ customerId: input.customer_id, date })
      : menuNutritionForDate(buildNutritionResult((await matterApiService.getSubscription(input.source_parent_subscription_id || input.subscription_id))?.data || {}), date);
    return live?.subscription_id != null && String(live.subscription_id) === String(input.subscription_id)
      && String(live.customer_id) === String(input.customer_id)
      && live.active_delivery_dates?.includes(date)
      && sameTerms(normalizeMatterAllergens(live.allergens), normalizeMatterAllergens(input.allergens))
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
  return createHash('sha256').update(JSON.stringify(['kitchen-upcoming-plans-v2', menu, records, breakfast, snack, items, archives])).digest('hex');
};

const capture = async menuId => {
  const [records, breakfast, snack] = await Promise.all([
    Record.find({ weeklyMenuId: menuId }).select('+kitchenAllergyConfirmations').populate({ path: 'selectedMeals.menuItemId',
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

const collectCapturedKitchenAllergies = async (menuId, date, selections, kitchenInputs, { fallbackOnly = false } = {}) => {
  const optionsByDate = new Map();
  const fallbackRows = selections.filter(row => (row.selectedMeals || []).some(meal => datedFallback(meal, date)));
  const cases = [];
  for (const nutrition of kitchenInputs) {
    const profile = nutrition.allergyProfile;
    const rows = !fallbackOnly && (profile?.allergies?.length || profile?.allergiesAvailable === false) ? selections : fallbackRows;
    for (const row of rows.filter(row => matchesKitchenAllergyRecord(row, nutrition))) {
      cases.push(...await collectSavedKitchenAllergies(menuId, date, row, nutrition, optionsByDate, { fallbackOnly }));
    }
  }
  return cases;
};

const withAllergyCases = (inputs, cases) => {
  const casesByMeal = new Map();
  for (const item of cases) {
    if (!item.mealId) continue;
    const key = `${item.recordId}:${item.mealId}`;
    if (!casesByMeal.has(key)) casesByMeal.set(key, []);
    casesByMeal.get(key).push(item);
  }
  const pending = cases.filter(item => !item.confirmation);
  return {
    ...inputs,
    kitchenSelections: inputs.kitchenSelections.map(({ kitchenAllergyConfirmations, ...row }) => ({
      ...row,
      selectedMeals: (row.selectedMeals || []).map(meal => {
        const reviews = casesByMeal.get(`${row._id}:${meal._id}`);
        return reviews ? { ...meal, kitchenAllergyCases: reviews } : meal;
      }),
    })),
    kitchenAllergyCases: cases,
    ...(pending.length && { kitchenAllergyReview: `${pending.length} saved meal allergy review(s) still need attention. Review each flagged meal in Kitchen List before exporting.` }),
  };
};

const readKitchenPreview = async (menuId, date, selectionWindow) => {
  const [roster, inputs] = await Promise.all([
    matterApiService.findSubscriptionsWithDeliveryOnDate(date, { includeKitchenInputs: true }), capture(menuId),
  ]);
  const kitchenInputs = withMenuAllergyProfiles(roster.map(row => row.kitchen_inputs).filter(Boolean));
  const cases = await collectCapturedKitchenAllergies(menuId, date, inputs.kitchenSelections, kitchenInputs);
  for (const sub of roster) {
    const identity = sub.kitchen_inputs || { ...sub, customer_email: sub.email };
    const exists = inputs.kitchenSelections.some(row => matchesKitchenAllergyRecord(row, identity));
    if (!exists) inputs.kitchenSelections.push({ email: sub.email, matterEmail: sub.email,
      matterCustomerId: sub.customer_id == null ? null : String(sub.customer_id), matterSubscriptionId: sub.subscription_id == null ? null : String(sub.subscription_id),
      firstName: sub.name || '', selectedMeals: [], _missingSelection: true, _missingSelectionDate: date });
  }
  return { success: true, preparation: 'selection-open', selectionWindow,
    preparedAt: new Date().toISOString(), data: { ...withAllergyCases(inputs, cases),
      kitchenRoster: roster, rosterComplete: true, kitchenInputs } };
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
    return { state: job.status, jobId: String(job._id), message: job.error };
  }
  const version = await sourceVersion(menuId);
  const ready = await Snapshot.findOne({ menuId, date, status: 'ready' }).sort({ createdAt: -1 }).lean();
  if (!refresh && ready) {
    const checked = await verifyReadyKitchenState(ready, menuId, date, verifyAllergies, version);
    if (['ready', 'allergy-review'].includes(checked.state) || verifyAllergies && checked.allergyChanged) return checked;
  }
  const running = await Snapshot.findOne({ menuId, date, status: 'running', createdAt: { $gte: new Date(Date.now() - 300000) } }).sort({ createdAt: -1 }).lean();
  return running ? { state: 'running', jobId: String(running._id) } : { state: 'missing' };
};

const verifyReadyKitchenState = async (snapshot, menuId, date, verifyAllergies, version) => {
  const stale = { state: 'stale', message: 'Kitchen inputs changed or expired. Reload the selected date before exporting.' };
  const before = version ?? await sourceVersion(menuId);
  if (!snapshotIsFresh(snapshot, before)) return stale;
  if (snapshot.payload?.data?.kitchenAllergyReview) return { state: 'allergy-review', data: snapshot.payload };
  const inputs = snapshot.payload?.data?.kitchenInputs || [];
  const selections = snapshot.payload?.data?.kitchenSelections || [];
  const hasFallbackSnacks = selections.some(row => (row.selectedMeals || []).some(meal => datedFallback(meal, date)));
  if (verifyAllergies && !await matterAllergiesAreCurrent(inputs, date, hasFallbackSnacks)) {
    const source = hasFallbackSnacks ? 'Matter allergies, exclusions, or delivery status' : 'Matter allergies or delivery status';
    return { state: 'stale', allergyChanged: true, message: `${source} changed. Refresh preparation before exporting.` };
  }
  if (hasFallbackSnacks) {
    // Restore only the active confirmations already verified by this snapshot.
    const records = selections.map(row => ({ ...row, kitchenAllergyConfirmations: (row.selectedMeals || [])
      .flatMap(meal => (meal.kitchenAllergyCases || []).filter(item => item.confirmation)
        .map(item => ({ fingerprint: item.fingerprint, ...item.confirmation }))) }));
    const pending = (await collectCapturedKitchenAllergies(menuId, date, records, inputs, { fallbackOnly: true }))
      .find(item => !item.confirmation);
    if (pending) return { state: 'stale', allergyChanged: true, message: pending.message };
  }
  if (verifyAllergies && before !== await sourceVersion(menuId)) return stale;
  return { state: 'ready', data: snapshot.payload };
};

export const beginKitchenState = async (menuId, date, prepare, options = {}) => {
  const current = await readKitchenState(menuId, date, undefined, options);
  if (current.state !== 'missing') return current;
  const job = await Snapshot.create({ menuId, date, status: 'running', expiresAt: new Date(Date.now() + 7 * 86400000) });
  setImmediate(async () => {
    try {
      const result = await prepare();
      if (result.data?.rosterComplete !== true || !Array.isArray(result.data.kitchenRoster) || !Array.isArray(result.data.kitchenInputs)) {
        throw new Error('The verified Matter roster is incomplete. Retry preparation before exporting.');
      }
      const before = await sourceVersion(menuId);
      const inputs = await capture(menuId);
      const cases = await collectCapturedKitchenAllergies(menuId, date, inputs.kitchenSelections, result.data.kitchenInputs || []);
      const data = { ...result.data, ...withAllergyCases(inputs, cases) };
      if (!data.kitchenAllergyReview) {
        if (result.failure) throw result.failure;
        assertPreparedCoverage(data, date, { allowManualHolds: true });
      }
      const selectionWindow = await readKitchenSelectionWindow(menuId, date);
      if (before !== await sourceVersion(menuId)) throw new Error('Selections changed during preparation. Retry this date.');
      job.payload = { success: true, preparation: data.kitchenAllergyReview ? 'allergy-review' : 'completed',
        selectionWindow, preparedAt: new Date().toISOString(), snapshotId: String(job._id), data };
      job.sourceVersion = before;
      job.status = 'ready';
      await job.save();
    } catch (error) {
      const failure = { status: 'failed', error: error.message || 'Kitchen preparation failed' };
      await Snapshot.updateOne({ _id: job._id }, { $set: failure }).catch(() => {});
    }
  });
  return { state: 'running', jobId: String(job._id) };
};
