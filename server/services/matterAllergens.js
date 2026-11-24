// Matter subscription detail supplies allergens separately from exclusions:
// allergens: [{ id, name }]. An omitted/malformed list is unknown, not empty.
export function normalizeMatterAllergens(value) {
  if (!Array.isArray(value)) return null;
  const names = new Map();
  for (const entry of value) {
    const labels = typeof entry === 'string' ? [entry]
      : [entry?.name, entry?.title, entry?.label, entry?.allergen?.name, entry?.allergen?.title];
    const clean = labels.find(label => typeof label === 'string' && label.trim())?.trim();
    if (!clean) return null;
    names.set(clean.toLowerCase(), clean);
  }
  return [...names.values()];
}
