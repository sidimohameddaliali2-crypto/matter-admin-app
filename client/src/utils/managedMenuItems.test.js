import { copyManagedMenuItem, managedMenuPayload } from './managedMenuItems';

test('copying a dish or day creates independent items without claiming the original ID', () => {
  const item = { menuItemId: 'selected-dish', _id: 'selected-dish', mealName: 'Chicken', carbIngredients: [{ name: 'Rice', visible: true }] };
  const copied = copyManagedMenuItem(item);
  expect(copied.menuItemId).toBeUndefined();
  expect(copied._id).toBeUndefined();
  copied.carbIngredients[0].name = 'Potato';
  expect(item.carbIngredients[0].name).toBe('Rice');
});

test('publish is included in the same payload as edited dishes and preserves item IDs', () => {
  const days = [{ date: '2026-10-30', items: [{ menuItemId: 'unchanged', mealName: 'Chicken' }] }];
  const payload = managedMenuPayload({ title: 'Menu' }, days, true);
  expect(payload).toMatchObject({ title: 'Menu', days, isPublished: true });
  expect(managedMenuPayload({ title: 'Menu' }, days, false)).not.toHaveProperty('isPublished');
});


test('copying a cycle-backed dish deep-copies nested component notes and exclusions', () => {
  const item = { menuItemId: 'original', cycleMeal: { id: 'cycle', components: [{ id: 'protein', exclusions: ['Nuts'], preparation: { note: 'Original' } }] } };
  const copy = copyManagedMenuItem(item); copy.cycleMeal.components[0].exclusions.push('Dairy'); copy.cycleMeal.components[0].preparation.note = 'Changed';
  expect(item.cycleMeal.components[0]).toEqual({ id: 'protein', exclusions: ['Nuts'], preparation: { note: 'Original' } });
});


test.each([undefined, null, '', '   ', 42])('missing or malformed title %s is rejected before a save payload is built', title => {
  for (const publish of [false, true]) expect(() => managedMenuPayload({title}, [], publish)).toThrow('Enter a menu title before saving or publishing.');
});

test('menu titles are trimmed without changing dish IDs or form state', () => {
  const form={title:'  Own menu  '};const days=[{items:[{menuItemId:'original'}]}];
  expect(managedMenuPayload(form,days,true)).toMatchObject({title:'Own menu',days,isPublished:true});
  expect(form.title).toBe('  Own menu  ');
});
