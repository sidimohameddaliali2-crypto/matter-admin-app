import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import Menu from '../models/WeeklyMenu.js';
import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';

const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const keyFor = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const positive = row => ['C', 'P', 'F'].some(key => Number(row[key]) > 0);

export const validateKitchenUpload = (input, menu) => {
  if (input.breakfastPresetRows != null && !Array.isArray(input.breakfastPresetRows)) invalid('Breakfast presets must be an array.');
  const dates = new Set();
  const missingMacros = [];
  let count = 0;
  for (const kind of ['mainByDate', 'snackByDate', 'breakfastByDate']) {
    const map = input[kind] || {};
    if (!map || typeof map !== 'object' || Array.isArray(map)) invalid(`Invalid ${kind} upload.`);
    for (const [date, group] of Object.entries(map)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) invalid(`Invalid date: ${date}`);
      if ((menu.startDate && date < new Date(menu.startDate).toISOString().slice(0, 10)) || (menu.endDate && date > new Date(menu.endDate).toISOString().slice(0, 10))) invalid(`${date} falls outside this menu week.`);
      dates.add(date);
      const pools = kind === 'mainByDate' ? [group.mainMeals, group.subMeals] : kind === 'snackByDate' ? [group.first, group.second] : [group];
      for (const pool of pools) {
        if (!Array.isArray(pool)) invalid(`Invalid meal list on ${date}.`);
        for (const row of pool) {
          if (!keyFor(row.name)) invalid(`A meal name is missing on ${date}.`);
          if (kind === 'mainByDate' && !['chicken', 'beef', 'fish'].includes(row.type)) invalid(`Protein type missing for ${row.name}.`);
          for (const macro of ['C', 'P', 'F']) if (row[macro] != null && (!Number.isFinite(Number(row[macro])) || Number(row[macro]) < 0)) invalid(`Invalid ${macro} for ${row.name}.`);
          if (kind === 'snackByDate' && !positive(row)) missingMacros.push(row.name);
          count++;
        }
      }
    }
  }
  for (const row of input.breakfastPresetRows || []) {
    if (!keyFor(row.breakfastName)) invalid('Breakfast name is missing.');
    for (const macro of ['C', 'P', 'F']) if (!Number.isFinite(Number(row[macro])) || Number(row[macro]) < 0) invalid(`Invalid breakfast ${macro}.`);
    if (!positive(row)) missingMacros.push(row.breakfastName);
  }
  if (!count || count > 5000) invalid('Upload must contain between 1 and 5000 meals.');
  return { dates: [...dates].sort(), count, missingMacros: [...new Set(missingMacros)] };
};

const version = docs => createHash('sha256').update(JSON.stringify(docs.map(doc => doc?.updatedAt || null))).digest('hex');

export const kitchenUpload = async (menuId, input) => {
  const read = async session => Promise.all([
    Menu.findById(menuId).session(session), Breakfast.findOne({ key: 'global' }).session(session), Snack.findOne({ key: 'global' }).session(session),
  ]);
  const docs = await read(null);
  if (!docs[0]) throw Object.assign(new Error('Menu not found'), { statusCode: 404 });
  const preview = validateKitchenUpload(input, docs[0]);
  const revision = version(docs);
  if (input.dryRun) return { ...preview, revision };
  if (input.expectedRevision !== revision) throw Object.assign(new Error('Menu or macros changed. Preview the upload again.'), { statusCode: 409 });
  await mongoose.connection.transaction(async session => {
    const [menu, breakfastDoc, snackDoc] = await read(session);
    if (version([menu, breakfastDoc, snackDoc]) !== revision) throw Object.assign(new Error('Upload changed during preview. Retry.'), { statusCode: 409 });
    for (const [date, row] of Object.entries(input.mainByDate || {})) menu.mainMealOptionsByDate.set(date, row);
    for (const [date, row] of Object.entries(input.snackByDate || {})) menu.snackOptionsByDate.set(date, row);
    for (const [date, row] of Object.entries(input.breakfastByDate || {})) menu.breakfastOptionsByDate.set(date, row);
    const breakfast = breakfastDoc || new Breakfast({ key: 'global' });
    for (const row of input.breakfastPresetRows || []) {
      const key = keyFor(row.breakfastName);
      if (positive(row) || !breakfast.presetsByName.has(key)) breakfast.presetsByName.set(key, row);
    }
    const snack = snackDoc || new Snack({ key: 'global' });
    for (const group of Object.values(input.snackByDate || {})) for (const row of [...group.first, ...group.second]) {
      const key = keyFor(row.name);
      if (positive(row) || !snack.presetsByName.has(key)) snack.presetsByName.set(key, { ...row, snackName: row.name });
    }
    await menu.save({ session });
    if ((input.breakfastPresetRows || []).length) await breakfast.save({ session });
    if (Object.keys(input.snackByDate || {}).length) await snack.save({ session });
  });
  return preview;
};
