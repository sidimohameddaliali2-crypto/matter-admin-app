import Rule from '../models/KitchenSnackRule.js';
import Snack from '../models/KitchenSnackPreset.js';
import { snackCatalogue, snackRuleConflict, resolveSnack } from './kitchenSnackPolicy.js';

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
export const loadSnackRules = async ids => {
  const keys = [...new Set(ids.filter(Boolean).map(String))];
  if (!keys.length) return new Map();
  return new Map((await Rule.find({ _id: { $in: keys } }).lean()).map(row => [row._id, row]));
};
export const saveSnackRule = async ({ customerId, keys, version, actor, presets, now = new Date() }) => {
  if (!Array.isArray(keys) || keys.length > 200 || keys.some(key => typeof key !== 'string')
    || !Number.isInteger(version) || version < 0) throw Object.assign(new Error('Select valid snacks and reload the current rule version.'), { statusCode: 400 });
  const existing = await Rule.findById(customerId).lean();
  if ((existing?.version || 0) !== version) throw conflict('Snack rules changed in another session. Reload before saving.');
  const catalogue = snackCatalogue(presets);
  const blockedSnacks = [...new Set(keys)].map(key => {
    const item = resolveSnack(key, catalogue) || (existing?.blockedSnacks || []).find(item => item.key === key);
    if (!item) throw Object.assign(new Error(`Unknown or ambiguous snack: ${key}. Reload the snack catalogue.`), { statusCode: 400 });
    return { key: item.key, name: item.name };
  });
  const history = { at: now, actor, before: (existing?.blockedSnacks || []).map(item => item.key), after: blockedSnacks.map(item => item.key) };
  if (!existing) {
    try { return (await Rule.create({ _id: customerId, blockedSnacks, version: 1, history: [history] })).toObject(); }
    catch (error) { if (error.code === 11000) throw conflict('Snack rules changed in another session. Reload before saving.'); throw error; }
  }
  const saved = await Rule.findOneAndUpdate({ _id: customerId, version }, {
    $set: { blockedSnacks }, $inc: { version: 1 }, $push: { history: { $each: [history], $slice: -100 } },
  }, { new: true }).lean();
  if (!saved) throw conflict('Snack rules changed in another session. Reload before saving.');
  return saved;
};

// Attach transient review flags; never alter selected meal documents on reads.
export const annotateSnackRules = (selections, rules, catalogue) => selections.map(row => {
  const rule = rules.get(String(row.matterCustomerId));
  return { ...row, snackRule: { blockedSnacks: rule?.blockedSnacks || [], version: rule?.version || 0 },
    selectedMeals: (row.selectedMeals || []).map(meal => ({ ...meal,
      snackRuleConflict: snackRuleConflict(meal, rule, catalogue) ? `Blocked snack: ${meal.mealName}. Review and replace this auto-assigned snack.` : null,
    })),
  };
});

export const readSnackCatalogue = async () => snackCatalogue((await Snack.findOne({ key: 'global' }).lean())?.presetsByName);
