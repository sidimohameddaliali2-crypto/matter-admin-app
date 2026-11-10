const COMPONENT_TYPES = new Set(['Protein', 'Breakfast', 'Snack', 'Carb', 'Vegetable', 'Salad', 'Sauce', 'Sauce 2', 'Extra sauce / topping', 'Garnish']);
const invalid = message => { throw Object.assign(new Error(`Cycle meal: ${message}`), { statusCode: 400 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const named = value => typeof value === 'string' && value.trim().length > 0;

// Keep the complete snapshot, including preparation/source metadata. Validation
// prevents malformed payloads from quietly turning dietary data into empty lists.
export function validateCycleMealSnapshot(value) {
  if (!object(value)) invalid('a meal snapshot object is required; it cannot be cleared.');
  if (!named(value.id) || !named(value.name)) invalid('meal ID and name are required.');
  if (!Array.isArray(value.components) || !value.components.length) invalid('components must be a non-empty array.');
  const ids = new Set();
  for (const component of value.components) {
    if (!object(component) || !named(component.id) || !named(component.name) || !COMPONENT_TYPES.has(component.type)) invalid('each component needs an ID, name and supported type.');
    if (ids.has(component.id)) invalid('component IDs must be unique.');
    ids.add(component.id);
    if (!Array.isArray(component.exclusions) || component.exclusions.some(flag => !named(flag))) invalid('component exclusions must be an array of non-empty strings.');
    if (component.notes !== undefined && typeof component.notes !== 'string') invalid('component notes must be text.');
  }
  if (value.carbCombined !== undefined && !['Yes', 'No', 'Not specified'].includes(value.carbCombined)) invalid('carbCombined must be Yes, No or Not specified.');
  for (const field of ['isSaladBase', 'isOatmeal']) if (value[field] !== undefined && typeof value[field] !== 'boolean') invalid(`${field} must be true or false.`);
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return invalid('the snapshot must contain JSON data.'); }
}
