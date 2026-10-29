const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const keyOf = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const safeKey = key => { if (!key || key.includes('.') || key.includes('$') || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid('Invalid snack preset name.'); return key; };

// Per-entry atomic writes preserve names added by another tab or a menu upload.
// Removal is explicit; omitting a name must never erase it.
export const snackPresetUpdate = ({ presets = [], removeKeys = [] } = {}) => {
  if (!Array.isArray(presets) || !Array.isArray(removeKeys)) invalid('presets and removeKeys must be arrays');
  const set = {}, unset = {};
  for (const row of presets) {
    const snackName = String(row?.snackName || row?.name || '').trim();
    const key = safeKey(keyOf(snackName));
    const value = { snackName };
    for (const field of ['C', 'P', 'F']) {
      const raw = row?.[field];
      if (raw == null || String(raw).trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) invalid(`Enter a valid ${field} value for ${snackName}.`);
      value[field] = Number(raw);
    }
    set[`presetsByName.${key}`] = value;
  }
  for (const name of removeKeys) {
    const key = `presetsByName.${safeKey(keyOf(name))}`;
    if (Object.hasOwn(set, key)) invalid('Cannot save and remove the same snack in one request.');
    unset[key] = '';
  }
  return { $set: { key: 'global', ...set }, ...(Object.keys(unset).length ? { $unset: unset } : {}) };
};
