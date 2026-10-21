const emailKey = value => String(value || '').trim().toLowerCase();
const normalize = value => {
  if (value instanceof Date) return value.toISOString();
  if (value?.toHexString) return value.toHexString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    if (value._id && Object.keys(value).some(key => key === 'mealName')) return String(value._id);
    return Object.fromEntries(Object.keys(value).filter(key => key !== '_id').sort().map(key => [key, normalize(value[key])]));
  }
  return value;
};
const equal = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
const represented = (items = [], archived = [], meals = false) => {
  const remaining = [...archived];
  return items.every(item => {
    const keys = Object.keys(item).filter(key => key !== '_id' && (!meals || key !== 'isAutoAssigned')
      && item[key] != null && item[key] !== '' && !(Array.isArray(item[key]) && !item[key].length));
    const index = remaining.findIndex(other => keys.every(key => equal(item[key], other[key])));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
};

// No deletion or merging on reads. Only suppress an already-approved archived
// copy when its retained account exists and the recreated copy adds no choices,
// notes, or pauses. Changed/unverified records remain visible for review.
export const excludeRecreatedArchivedAliases = (records, archives) => records.filter(row => {
  if (row.matterCustomerId) return true;
  return !archives.some(archive => {
    const original = archive.original;
    if (!original || String(row.weeklyMenuId) !== String(original.weeklyMenuId)
      || emailKey(row.email) !== emailKey(original.email)) return false;
    const retained = records.find(candidate => String(candidate._id) === String(archive.retainedSelectionId)
      && candidate.matterCustomerId && String(candidate.matterCustomerId) === String(archive.matterCustomerId));
    return !!retained && represented(row.selectedMeals, original.selectedMeals, true)
      && represented(row.dayNotes, original.dayNotes) && represented(row.skippedDays, original.skippedDays);
  });
});
