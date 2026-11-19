// Core alternates first/second pools. A failed first slot must not make a
// saved second-slot snack count as first on the next preparation attempt.
export function missingCoreSnackSlots(meals, count, pools) {
  const occupied = new Set();
  const slots = Array.from({ length: Math.max(0, Math.floor(count)) }, (_, slot) => slot);
  const name = value => String(value || '').trim().toLowerCase();
  const portions = meal => Math.max(1, Math.floor(Number(meal.quantity) || 1));
  const unnumbered = [];
  for (const meal of meals) {
    const start = meal.slotNumber;
    if (Number.isInteger(start) && start >= 0 && start < count) {
      for (let offset = 0; offset < portions(meal); offset++) {
        if (start + offset < count) occupied.add(start + offset);
      }
    } else unnumbered.push(meal);
  }
  // Preserve legacy saved snacks without rewriting them. Prefer the pool
  // matching their name, then consume an available slot if metadata changed.
  for (const meal of unnumbered) {
    const first = pools.first.some(option => name(option.name) === name(meal.mealName));
    const second = pools.second.some(option => name(option.name) === name(meal.mealName));
    for (let portion = 0; portion < portions(meal); portion++) {
      const preferred = slots.find(slot => !occupied.has(slot) && (slot % 2 === 0 ? first : second));
      const slot = preferred ?? slots.find(slot => !occupied.has(slot));
      if (slot !== undefined) occupied.add(slot);
    }
  }
  return slots.filter(slot => !occupied.has(slot));
}
