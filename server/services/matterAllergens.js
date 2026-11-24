// Matter subscription detail supplies allergens separately from exclusions:
// allergens: [{ id, name }]. An omitted/malformed list is unknown, not empty.
export function normalizeMatterAllergens(value) {
  if (!Array.isArray(value)) return null;
  const names = new Map();
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !name.trim()) return null;
    const clean = name.trim();
    names.set(clean.toLowerCase(), clean);
  }
  return [...names.values()];
}
