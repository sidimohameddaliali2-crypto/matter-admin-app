export const copyManagedMenuItem = item => {
  const copy = JSON.parse(JSON.stringify(item));
  delete copy.menuItemId;
  delete copy._id;
  return copy;
};

export const managedMenuPayload = (form, days, publish) => ({ ...form, days, ...(publish ? { isPublished: true } : {}) });
