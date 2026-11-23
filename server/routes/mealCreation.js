import express from 'express';
import State from '../models/MealCreationState.js';
import Menu from '../models/WeeklyMenu.js';
import { protect } from '../middleware/auth.js';
import { effectivePermissions } from '../models/User.js';
import { changeMealCreationState, recoverMealCreationState, mergeLegacyDraft, repairMealCreationState } from '../services/mealCreationState.js';

const router = express.Router();
router.use(protect, (req, res, next) => effectivePermissions(req.user).menus ? next() : res.status(403).json({ success: false, message: 'Menu access is required.' }));
const output = state => ({ catalogue: state.catalogue, boards: state.boards, cycles: state.cycles || [], aliases: state.aliases || [], revision: state.revision, recovery: state.recovery });
const conflict = res => res.status(409).json({ success: false, message: 'The meal library was changed in another tab. Reload before editing; your current draft has not overwritten it.' });
const notifyKitchenLibraryChanged = req => req.app?.get('io')?.emit('kitchen:mealLibraryChanged');

router.post('/bootstrap', async (req, res) => {
  let wroteLibrary = false;
  try {
    let current = await State.findById('shared').lean();
    if (!current || !current.catalogue?.meals?.length || current.cycles === undefined) {
      const menus = await Menu.find({}).sort({ updatedAt: -1, _id: -1 })
        .select('meals updatedAt').populate({ path: 'meals.items', model: 'MenuItem', select: 'cycleMeal mealType rotationCategory usedForCorePlan' }).lean();
      const recovered = recoverMealCreationState(menus);
      // A surviving browser draft is newer than the historical menu copies.
      const initial = changeMealCreationState(req.body?.legacy ? mergeLegacyDraft(recovered, req.body.legacy, false) : recovered, {});
      if (current) {
        const repaired = repairMealCreationState(current, initial);
        if (initial.catalogue.meals.length) {
          // Repair older empty/partial shared documents from saved menu copies.
          // Menus and existing library edits remain untouched.
          current = await State.findOneAndUpdate({ _id: 'shared', revision: current.revision }, { $set: { ...repaired, recovery: recovered.recovery }, $inc: { revision: 1 } }, { new: true }).lean();
          if (!current) return conflict(res);
          wroteLibrary = true;
        }
      } else {
        try {
          current = (await State.create({ _id: 'shared', ...initial, recovery: recovered.recovery })).toObject();
          wroteLibrary = true;
        }
        catch (error) { if (error.code !== 11000) throw error; current = await State.findById('shared').lean(); }
      }
    }
    {
      const merged = mergeLegacyDraft(current, req.body?.legacy);
      if (JSON.stringify(merged) !== JSON.stringify({ catalogue: current.catalogue, boards: current.boards, aliases: current.aliases || [], cycles: current.cycles || [] })) {
        current = await State.findOneAndUpdate({ _id: 'shared', revision: current.revision }, { $set: merged, $inc: { revision: 1 } }, { new: true }).lean();
        if (!current) return conflict(res);
        wroteLibrary = true;
      }
    }
    return res.json({ success: true, data: output(current) });
  } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
  finally { if (wroteLibrary) notifyKitchenLibraryChanged(req); }
});

router.get('/', async (req, res) => {
  try {
    const state = await State.findById('shared').lean();
    if (!state) return res.status(404).json({ success: false, message: 'Open Menu Creation to initialize the meal library.' });
    return res.json({ success: true, data: output(state) });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.put('/', async (req, res) => {
  try {
    if (!Number.isInteger(req.body?.revision) || req.body.revision < 0) return conflict(res);
    const current = await State.findById('shared').lean();
    if (!current || current.revision !== req.body.revision) return conflict(res);
    const update = changeMealCreationState(current, req.body);
    const state = await State.findOneAndUpdate({ _id: 'shared', revision: current.revision }, { $set: update, $inc: { revision: 1 } }, { new: true }).lean();
    if (!state) return conflict(res);
    if (req.body.catalogue) notifyKitchenLibraryChanged(req);
    return res.json({ success: true, data: output(state) });
  } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
});

export default router;
