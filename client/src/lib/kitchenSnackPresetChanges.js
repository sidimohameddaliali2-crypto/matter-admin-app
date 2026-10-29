export const snackPresetChanges = (before, after) => ({
  presets: Object.entries(after).filter(([key, value]) => !before[key] || ['snackName', 'C', 'P', 'F'].some(field => String(value[field]) !== String(before[key][field]))).map(([, value]) => value),
  removeKeys: Object.keys(before).filter(key => !Object.hasOwn(after, key)),
});
