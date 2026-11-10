import { toTitleCase } from './textFormat';

// Kept sides are audit details, never replacement lists used by the kitchen.
export const selectionComponentDetails = meal => [
  ['replace', 'carb', meal?.carbConflict],
  ['replace', 'veg', meal?.vegConflict],
  // Older records kept scoped side matches in the original conflict arrays.
  ['kept', 'carb', meal?.keptCarbConflict ?? (meal?.carbVegAction === 'kept' ? meal.carbConflict : [])],
  ['kept', 'veg', meal?.keptVegConflict ?? (meal?.carbVegAction === 'kept' ? meal.vegConflict : [])],
].filter(([action, , conflicts]) => conflicts?.length && (action === 'kept' || meal?.carbVegAction === 'replace'))
  .map(([action, component, conflicts]) => ({
    action, component,
    label: `${action === 'kept' ? 'Keep' : 'Replace'} ${component}`,
    detail: [...new Set(conflicts.map(toTitleCase))].join(', '),
  }));

export const selectionHasWarning = meal => !!(meal?.conflict || meal?.preferenceConflict?.length);
