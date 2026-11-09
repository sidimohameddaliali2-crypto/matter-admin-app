// Owner (2026-11-09): only Menu Selection items have delivery-date windows.
export const partnerMenuNameKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
export const partnerMenuNamePattern = name => new RegExp('^\\s*' + String(name || '').trim().split(/\s+/)
  .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+') + '\\s*$', 'i');

export const partnerMenuView = item => {
  const value = typeof item.toObject === 'function' ? item.toObject() : { ...item };
  return value.source === 'menu-selection' ? value : { ...value, availableFrom: null, availableTo: null };
};

// Filter for the partner and date first. Keep a stable existing ID for legacy
// casing duplicates, preserving order references and per-partner prices.
export const uniquePartnerMenuItems = items => {
  const seen = new Set();
  return [...items].sort((a, b) => String(a._id).localeCompare(String(b._id))).filter(item => {
    const key = item.source === 'menu-selection' && item.mealType === 'main'
      ? 'main|' + partnerMenuNameKey(item.name) + '|' + partnerMenuNameKey(item.category)
      : 'id|' + String(item._id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
