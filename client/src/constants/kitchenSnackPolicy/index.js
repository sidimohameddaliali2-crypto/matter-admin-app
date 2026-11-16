// Shared by preparation, List and Counting. Exact names and explicit aliases
// only; never substring matching.
// Uploads routinely append ingredient annotations to otherwise identical names.
export const snackKey = value => String(value || '').normalize('NFKC').trim().toLowerCase()
  .replace(/\(\s*w\s*\/[^)]*\)/gi, '').replace(/[^a-z0-9]+/g, ' ').trim();
const entries = presets => presets instanceof Map ? [...presets] : Object.entries(presets || {});
export const snackCatalogue = presets => entries(presets).map(([key, value]) => ({
  key: snackKey(value.snackName || key), name: value.snackName || key,
  aliases: [key, ...(value.aliases || [])].map(snackKey),
  hasMacros: ['C', 'P', 'F'].every(k => value[k] != null && value[k] !== '' && Number.isFinite(Number(value[k])) && Number(value[k]) >= 0)
    && ['C', 'P', 'F'].some(k => Number(value[k]) > 0),
}));
export const resolveSnack = (name, catalogue) => {
  const key = snackKey(name);
  const matches = catalogue.filter(item => item.key === key || item.aliases.includes(key));
  return matches.length === 1 ? matches[0] : null;
};
export const snackBlocked = (name, rule, catalogue) => {
  const key = resolveSnack(name, catalogue)?.key || snackKey(name);
  return (rule?.blockedSnacks || []).some(item => item.key === key);
};
const snackHasMacros = (name, catalogue) => {
  const exact = resolveSnack(name, catalogue);
  if (exact) return exact.hasMacros;
  // Preserve the existing unique preset-name macro fallback. This is used
  // only for macro availability, never to infer which snack a rule blocks.
  const compact = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const needle = compact(name);
  const matches = catalogue.filter(item => item.aliases.some(alias => compact(alias)
    && (needle.includes(compact(alias)) || compact(alias).includes(needle))));
  return matches.length === 1 && matches[0].hasMacros;
};
export const eligibleSnackPools = (pools, { rule, catalogue, excluded }) => {
  const eligible = option => snackHasMacros(option.name, catalogue)
    && !snackBlocked(option.name, rule, catalogue) && !excluded(option);
  return { first: (pools.first || []).filter(eligible), second: (pools.second || []).filter(eligible) };
};
export const preferredSnackPool = (pools, slot) => {
  const preferred = slot % 2 === 0 ? pools.first : pools.second;
  return preferred.length ? preferred : slot % 2 === 0 ? pools.second : pools.first;
};
export const snackRuleConflict = (meal, rule, catalogue) => meal.mealType === 'snack'
  && meal.isAutoAssigned === true && snackBlocked(meal.mealName, rule, catalogue);
