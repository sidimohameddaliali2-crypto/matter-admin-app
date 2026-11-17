// Recipes are unique library records; workbook IDs and days belong to a cycle.
// These are view copies so selecting a cycle never edits the shared recipe.
export function mealsForCycle(meals, cycle, cycles = []) {
  if (!cycle) {
    if (!cycles.length) return meals;
    const sourceIds = new Map();
    for (const saved of cycles) for (const item of saved.meals || []) {
      const ids = sourceIds.get(item.mealId) || new Set();
      ids.add(item.sourceMealId || item.mealId); sourceIds.set(item.mealId, ids);
    }
    return meals.map(meal => ({ ...meal, sourceMealIds: [...(sourceIds.get(meal.id) || [meal.id])] }));
  }
  const byId = new Map(meals.map(meal => [meal.id, meal]));
  const grouped = new Map();
  for (const occurrence of cycle.meals || []) {
    const meal = byId.get(occurrence.mealId);
    if (!meal) continue;
    const current = grouped.get(meal.id) || { ...meal, day: '', cycleDays: [], sourceMealIds: [] };
    current.cycleDays = [...new Set([...current.cycleDays, occurrence.day, ...(occurrence.cycleDays || [])].filter(Boolean))];
    current.day = current.cycleDays[0] || '';
    current.sourceMealIds = [...new Set([...current.sourceMealIds, occurrence.sourceMealId || meal.id])];
    grouped.set(meal.id, current);
  }
  return [...grouped.values()];
}
