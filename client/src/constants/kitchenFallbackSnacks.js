export const KITCHEN_FALLBACK_SNACKS = [
  'CRACKER BLISS BALL',
  'CHOCO PEANUT BUTTER TRUFFLE',
  'CHEESECAKE BITES',
];

export const kitchenSnackRecipeKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
export const kitchenFallbackSnackKey = name => kitchenSnackRecipeKey(name).replace(/\s*\((?:w\/|with\b|contains\b)[^()]*\)\s*$/i, '').trim();

export function findKitchenFallbackSnackPreset(name, presets) {
  const entries = presets instanceof Map ? [...presets] : Object.entries(presets || {});
  const entry = entries.find(([key]) => kitchenSnackRecipeKey(key) === kitchenSnackRecipeKey(name))?.[1];
  const values = ['C', 'P', 'F'].map(key => entry?.[key]);
  if (!values.every(value => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0)
    || !values.some(value => Number(value) > 0)) return null;
  return { C: Number(entry.C), P: Number(entry.P), F: Number(entry.F) };
}
