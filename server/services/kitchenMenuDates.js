const dateKey = value => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

export { dateKey as menuDateKey };

// Same date discovery as the client, without transferring customer records.
export const kitchenMenuDates = (menu, selectedDates = [], uploadedDates = []) => {
  const keys = new Set([...selectedDates, ...uploadedDates].map(dateKey).filter(Boolean));
  for (const field of ['mainMealOptionsByDate', 'breakfastOptionsByDate', 'snackOptionsByDate']) {
    for (const key of Object.keys(menu[field] || {})) keys.add(key);
  }
  if (!keys.size) {
    const start = dateKey(menu.startDate), end = dateKey(menu.endDate);
    if (start && end) for (let ms = Date.parse(start), i = 0; ms <= Date.parse(end) && i < 31; ms += 86400000, i++) keys.add(dateKey(ms));
  }
  return [...keys].sort();
};
