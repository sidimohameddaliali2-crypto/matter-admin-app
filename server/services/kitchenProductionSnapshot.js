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

export const snapshotIsFresh = (snapshot, sourceVersion, now = Date.now()) => snapshot?.status === 'ready'
  && snapshot.sourceVersion === sourceVersion && now >= new Date(snapshot.updatedAt).getTime()
  && now - new Date(snapshot.updatedAt).getTime() < 60000;

const sourceVersion = async menuId => {
  const menu = await Menu.findById(menuId).lean();
  if (!menu) throw Object.assign(new Error('Menu not found'), { statusCode: 404 });
  const [records, breakfast, snack, items, archives] = await Promise.all([
    Record.find({ weeklyMenuId: menuId }).select('_id updatedAt __v').sort({ _id: 1 }).lean(),
    Breakfast.findOne({ key: 'global' }).lean(), Snack.findOne({ key: 'global' }).lean(),
    MenuItem.find({ _id: { $in: (menu.meals || []).flatMap(day => day.items || []) } }).select('_id updatedAt __v').sort({ _id: 1 }).lean(),
    Archive.find({ 'original.weeklyMenuId': menuId }).select('_id createdAt updatedAt').sort({ _id: 1 }).lean(),
  ]);
  return createHash('sha256').update(JSON.stringify([menu, records, breakfast, snack, items, archives])).digest('hex');
};

const capture = async menuId => {
  const [records, breakfast, snack] = await Promise.all([
    Record.find({ weeklyMenuId: menuId }).populate('selectedMeals.menuItemId', '_id mealName mealType itemDate portionType rotationCategory usedForCorePlan').sort({ submittedAt: -1 }).lean(),
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

export const readKitchenState = async (menuId, date, jobId) => {
  if (jobId) {
    if (!mongoose.isValidObjectId(jobId)) throw Object.assign(new Error('Invalid preparation ID'), { statusCode: 400 });
    const job = await Snapshot.findOne({ _id: jobId, menuId, date }).lean();
    if (!job) return { state: 'missing' };
    if (job.status === 'running' && Date.now() - new Date(job.createdAt).getTime() > 300000) return { state: 'failed', message: 'Preparation expired. Retry the selected date.' };
    if (job.status === 'ready') return snapshotIsFresh(job, await sourceVersion(menuId))
      ? { state: 'ready', data: job.payload } : { state: 'stale', message: 'Kitchen inputs changed during preparation. Reload the selected date.' };
    return { state: job.status, jobId: String(job._id), message: job.error };
  }
  const version = await sourceVersion(menuId);
  const ready = await Snapshot.findOne({ menuId, date, status: 'ready' }).sort({ createdAt: -1 }).lean();
  if (snapshotIsFresh(ready, version)) return { state: 'ready', data: ready.payload };
  const running = await Snapshot.findOne({ menuId, date, status: 'running', createdAt: { $gte: new Date(Date.now() - 300000) } }).sort({ createdAt: -1 }).lean();
  return running ? { state: 'running', jobId: String(running._id) } : { state: 'missing' };
};

export const beginKitchenState = async (menuId, date, prepare) => {
  const current = await readKitchenState(menuId, date);
  if (current.state !== 'missing') return current;
  const job = await Snapshot.create({ menuId, date, status: 'running', expiresAt: new Date(Date.now() + 7 * 86400000) });
  setImmediate(async () => {
    try {
      const result = await prepare();
      const before = await sourceVersion(menuId);
      const inputs = await capture(menuId);
      assertPreparedCoverage({ ...result.data, ...inputs }, date);
      if (before !== await sourceVersion(menuId)) throw new Error('Selections changed during preparation. Retry this date.');
      job.payload = { success: true, preparation: 'completed', preparedAt: new Date().toISOString(), snapshotId: String(job._id), data: { ...result.data, ...inputs } };
      job.sourceVersion = before;
      job.status = 'ready';
      await job.save();
    } catch (error) {
      await Snapshot.updateOne({ _id: job._id }, { $set: { status: 'failed', error: error.message || 'Kitchen preparation failed' } }).catch(() => {});
    }
  });
  return { state: 'running', jobId: String(job._id) };
};
