// Restart the first/second pool rotation for each food day in a delivery.
export const coreSnackPoolForSlot = (slot, snacksPerDay) => (slot % snacksPerDay) % 2 === 0 ? 'first' : 'second';

// A failed first slot must not make a saved second-slot snack count as first
// on the next preparation attempt.
export function missingCoreSnackSlots(meals, count, eligiblePools, originalPools = eligiblePools, snacksPerDay = count) {
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
  // matching their name among customer-eligible options. If none match, a
  // unique original pool match preserves the slot of a now-ineligible snack.
  // Ambiguous or removed legacy names still consume one available slot.
  for (const meal of unnumbered) {
    let first = eligiblePools.first.some(option => name(option.name) === name(meal.mealName));
    let second = eligiblePools.second.some(option => name(option.name) === name(meal.mealName));
    if (!first && !second) {
      const originalFirst = originalPools.first.some(option => name(option.name) === name(meal.mealName));
      const originalSecond = originalPools.second.some(option => name(option.name) === name(meal.mealName));
      if (originalFirst !== originalSecond) {
        first = originalFirst;
        second = originalSecond;
      }
    }
    for (let portion = 0; portion < portions(meal); portion++) {
      const preferred = slots.find(slot => !occupied.has(slot) && (coreSnackPoolForSlot(slot, snacksPerDay) === 'first' ? first : second));
      const slot = preferred ?? slots.find(slot => !occupied.has(slot));
      if (slot !== undefined) occupied.add(slot);
    }
  }
  return slots.filter(slot => !occupied.has(slot));
}
