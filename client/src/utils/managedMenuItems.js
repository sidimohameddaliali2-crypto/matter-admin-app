export const copyManagedMenuItem = item => {
  const copy = { ...item };
  delete copy.menuItemId;
  delete copy._id;
  return Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, Array.isArray(value) ? value.map(entry => entry && typeof entry === 'object' ? { ...entry } : entry) : value]));
};

export const managedMenuPayload = (form, days, publish) => ({ ...form, days, ...(publish ? { isPublished: true } : {}) });
