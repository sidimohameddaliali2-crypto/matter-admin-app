import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMcpMealReader } from './matterMcpMeals.js';
import { createMcpMealsRouter } from '../routes/mcpMeals.js';

const menuId = '111111111111111111111111';
const secondMenuId = '222222222222222222222222';
const rowId = '333333333333333333333333';
const date = '2026-11-08';
const item = { _id: '444444444444444444444444', mealName: 'Saved menu dish', mealType: 'main' };
const menu = { _id: menuId, title: 'Week A', startDate: '2026-11-02T00:00:00.000Z', endDate: '2026-11-08T00:00:00.000Z',
  isActive: true, isPublished: true, shareLink: { token: 'private-share-token' },
  meals: [{ date: '2026-11-07T00:00:00.000Z', mealType: 'main', items: [{ ...item, mealName: 'Other day' }] },
    { date: `${date}T00:00:00.000Z`, mealType: 'main', items: [item, null] }],
  mainMealOptionsByDate: { [date]: { mainMeals: [{ name: 'Chicken', type: 'chicken' }], subMeals: [{ name: 'Fish', type: 'fish' }] } },
  breakfastOptionsByDate: { [date]: [{ name: 'Breakfast' }] },
  snackOptionsByDate: { [date]: { first: [{ name: 'Snack A' }], second: [{ name: 'Snack B' }] } },
  matterCoreMealOptionsByDate: { [date]: [{ name: 'Core dish' }] },
};
const row = { _id: rowId, weeklyMenuId: menuId, email: 'legacy-storage@example.com', matterEmail: 'a+b@example.com',
  matterCustomerId: 'MATTER-101', selectedMeals: [
    { date: `${date}T00:00:00.000Z`, mealType: 'main', mealName: 'Customer saved choice', menuItemId: item,
      quantity: 2, slotNumber: 1, proteinChoice: 'Chicken', remark: 'Kitchen-only remark' },
    { date: `${date}T00:00:00.000Z`, mealType: 'snack', mealName: 'Kitchen snack', isAutoAssigned: true },
    { date: '2026-11-09T00:00:00.000Z', mealName: 'Next day' },
  ], dayNotes: [{ date, note: 'Private kitchen note' }],
  skippedDays: [{ date, pauseStatus: 'declined', resumeDate: '2026-11-09' }],
};
const query = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; },
  limit() { return this; }, async lean() { return structuredClone(value); } });
function setup({ menuRows = [menu], rows = [row], archiveRows = [] } = {}) {
  const calls = {};
  const reader = createMcpMealReader({ menus: {
    find(filter) { calls.menus = filter; return query(menuRows); },
    findById(identifier) { calls.menuId = identifier; return query(menuRows.find(entry => entry._id === identifier) || null); },
  }, selections: { find(filter) { calls.selections = filter; return query(rows); } },
  archives: { find(filter) { calls.archives = filter; return query(archiveRows); } } });
  return { reader, calls };
}

test('daily menus return only the selected menu day and preserve separate rotation pools without share tokens', async () => {
  const { reader, calls } = setup();
  const result = await reader.dailyMenu({ date });
  assert.equal(result.found, true);
  assert.equal(calls.menus.isActive, true);
  assert.equal(result.menus[0].menuId, menuId);
  assert.deepEqual(result.menus[0].meals[0].items, [item]);
  assert.equal(result.menus[0].mainMealOptions.subMeals[0].name, 'Fish');
  assert.equal(result.menus[0].snackOptions.second[0].name, 'Snack B');
  assert.equal(result.menus[0].matterCoreMealOptions[0].name, 'Core dish');
  assert.ok(!JSON.stringify(result).includes('private-share-token'));
  assert.ok(!JSON.stringify(result).includes('Other day'));
});

test('overlapping menus stay explicit and historical menus require an exact menu ID', async () => {
  const { reader } = setup({ menuRows: [menu, { ...menu, _id: secondMenuId, title: 'Another active menu' }] });
  assert.equal((await reader.dailyMenu({ date })).requiresMenuChoice, true);
  const historical = setup({ menuRows: [{ ...menu, _id: secondMenuId, isActive: false, title: 'Historical' }] });
  const result = await historical.reader.dailyMenu({ date, menuId: secondMenuId });
  assert.deepEqual(historical.calls.menus, { _id: secondMenuId });
  assert.equal(result.menus[0].isActive, false);
  const missing = setup({ menuRows: [] });
  assert.equal((await missing.reader.dailyMenu({ date })).found, false);
  await assert.rejects(missing.reader.dailyMenu({ date, menuId }), { statusCode: 404 });
});

test('customer choices are read from their exact weekly menu and remain distinct from kitchen assignments', async () => {
  const { reader, calls } = setup();
  const result = await reader.customerMeals({ date, menuId, matterCustomerId: 'MATTER-101', includeKitchen: true });
  assert.deepEqual(calls.selections, { weeklyMenuId: menuId, matterCustomerId: 'MATTER-101' });
  assert.equal(result.customerSelections.length, 1);
  assert.equal(result.customerSelections[0].mealName, 'Customer saved choice');
  assert.equal(result.customerSelections[0].quantity, 2);
  assert.equal(result.customerSelections[0].proteinChoice, 'Chicken');
  assert.equal(result.kitchenAssignments[0].source, 'kitchen_assignment');
  assert.equal(result.dayNotes[0].note, 'Private kitchen note');
  assert.equal(result.skippedDays[0].pauseStatus, 'declined');
  assert.equal(result.identity.email, 'a+b@example.com');
  assert.ok(!JSON.stringify(result).includes('Next day'));
  const nonKitchen = await reader.customerMeals({ date, menuId, matterCustomerId: 'MATTER-101' });
  assert.equal(nonKitchen.kitchenAssignments, undefined);
  assert.equal(nonKitchen.dayNotes, undefined);
  assert.ok(!JSON.stringify(nonKitchen).includes('Kitchen-only remark'));
});

test('email identity uses an exact escaped website email and a constrained legacy fallback', async () => {
  const { reader, calls } = setup();
  await reader.customerMeals({ date, menuId, email: ' A+B@EXAMPLE.COM ' });
  const [modern, legacy] = calls.selections.$or;
  assert.ok(modern.matterEmail.test('a+b@example.com'));
  assert.ok(!modern.matterEmail.test('ab@example.com'));
  assert.ok(!modern.matterEmail.test('prefix-a+b@example.com'));
  assert.deepEqual(legacy.matterEmail, { $in: [null, ''] });
  assert.deepEqual(legacy.matterCustomerId, { $in: [null, ''] });
  assert.ok(legacy.email.test('a+b@example.com'));
});

test('invalid dates, ambiguous accounts, and missing records do not infer or assign choices', async () => {
  const { reader } = setup();
  await assert.rejects(reader.dailyMenu({ date: '2026-02-30' }), { statusCode: 400 });
  await assert.rejects(reader.customerMeals({ date, email: 'a+b@example.com' }), { statusCode: 400 });
  await assert.rejects(reader.customerMeals({ date: '2026-12-01', menuId, matterCustomerId: 'MATTER-101' }), { statusCode: 400 });
  await assert.rejects(reader.customerMeals({ date, menuId, email: 'a+b@example.com', matterCustomerId: 'MATTER-101' }), { statusCode: 400 });
  const ambiguous = setup({ rows: [row, { ...row, _id: '555555555555555555555555', matterCustomerId: 'OTHER' }] });
  await assert.rejects(ambiguous.reader.customerMeals({ date, menuId, email: 'a+b@example.com' }), { statusCode: 409 });
  const missing = setup({ rows: [] });
  const result = await missing.reader.customerMeals({ date, menuId, matterCustomerId: 'MATTER-101' });
  assert.equal(result.found, false);
  assert.deepEqual(result.customerSelections, []);
  const assignedOnly = setup({ rows: [{ ...row, selectedMeals: row.selectedMeals.filter(meal => meal.isAutoAssigned) }] });
  assert.deepEqual((await assignedOnly.reader.customerMeals({ date, menuId, matterCustomerId: 'MATTER-101' })).customerSelections, []);
});

test('approved archived aliases cannot override permanent identity or resurrect a reconciled storage email', async () => {
  const legacy = { ...row, _id: '666666666666666666666666', matterCustomerId: undefined, matterEmail: undefined, email: 'a+b@example.com' };
  const archived = { original: structuredClone(legacy), retainedSelectionId: rowId, matterCustomerId: row.matterCustomerId };
  const { reader, calls } = setup({ rows: [legacy, row], archiveRows: [archived] });
  const result = await reader.customerMeals({ date, menuId, email: 'a+b@example.com' });
  assert.equal(result.identity.matterCustomerId, 'MATTER-101');
  assert.equal(String(calls.archives['original.weeklyMenuId']), menuId);
  const loneAlias = setup({ rows: [legacy], archiveRows: [archived] });
  await assert.rejects(loneAlias.reader.customerMeals({ date, menuId, email: 'a+b@example.com' }), { statusCode: 409 });
});

test('staff read routes enforce menu, customer, and kitchen-detail permissions independently', async () => {
  const calls = [];
  const app = express();
  app.use('/api/mcp-meals', createMcpMealsRouter({ authenticate: (req, res, next) => {
    const role = req.headers['x-fixture-role'];
    if (!role) return res.sendStatus(401);
    req.user = { role: 'admin', permissionsConfigured: true, permissions: {
      menus: role !== 'none', kitchen_list: role === 'kitchen', customers: role === 'customer' || role === 'kitchen',
    } };
    next();
  }, reader: { async dailyMenu(input) { calls.push(input); return {}; }, async customerMeals(input) { calls.push(input); return {}; } } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const get = (path, role) => fetch(`http://127.0.0.1:${server.address().port}/api/mcp-meals${path}`, {
    headers: role ? { 'x-fixture-role': role } : {},
  });
  try {
    assert.equal((await get(`/menus?date=${date}`)).status, 401);
    assert.equal((await get(`/menus?date=${date}`, 'none')).status, 403);
    assert.equal((await get(`/menus?date=${date}`, 'menu')).status, 200);
    assert.equal((await get('/selections', 'menu')).status, 403);
    assert.equal((await get('/selections', 'customer')).status, 200);
    assert.equal(calls.at(-1).includeKitchen, false);
    assert.equal((await get('/selections', 'kitchen')).status, 200);
    assert.equal(calls.at(-1).includeKitchen, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
