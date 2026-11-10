export const copyManagedMenuItem = item => {
  const copy = JSON.parse(JSON.stringify(item));
  delete copy.menuItemId;
  delete copy._id;
  return copy;
};

export const MENU_TITLE_REQUIRED = 'Enter a menu title before saving or publishing.';

export const managedMenuPayload = (form, days, publish) => {
  if (typeof form.title !== 'string' || !form.title.trim()) {
    throw Object.assign(new Error(MENU_TITLE_REQUIRED), { code: 'MENU_TITLE_REQUIRED' });
  }
  return { ...form, title: form.title.trim(), days, ...(publish ? { isPublished: true } : {}) };
};
