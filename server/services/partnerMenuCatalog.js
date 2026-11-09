// Owner (2026-11-09): only Menu Selection items have delivery-date windows.
export const partnerMenuNameKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
export const partnerMenuNamePattern = name => new RegExp('^\\s*' + String(name || '').trim().split(/\s+/)
  .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+') + '\\s*$', 'i');

export const partnerMenuView = item => {
  const value = typeof item.toObject === 'function' ? item.toObject() : { ...item };
  return value.source === 'menu-selection' ? value : { ...value, availableFrom: null, availableTo: null };
};

// Filter for the partner/date first. During editing prefer the order's IDs,
// retaining every referenced duplicate so each original line stays editable.
export const uniquePartnerMenuItems = (items, referencedIds = []) => {
  const referenced = new Set(referencedIds.map(String));
  const seen = new Set();
  const seenIds = new Set();
  return [...items].sort((a, b) => Number(referenced.has(String(b._id))) - Number(referenced.has(String(a._id)))
    || String(a._id).localeCompare(String(b._id))).filter(item => {
    const id = String(item._id);
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    const key = item.source === 'menu-selection' && item.mealType === 'main'
      ? 'main|' + partnerMenuNameKey(item.name) + '|' + partnerMenuNameKey(item.category)
      : 'id|' + id;
    if (seen.has(key) && !referenced.has(id)) return false;
    seen.add(key);
    return true;
  });
};
