import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import router from './menus.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Menu from '../models/WeeklyMenu.js';
import Record from '../models/MenuSelectionRecord.js';
import matter from '../services/matterApiService.js';
import { issueMenuSession, menuSessions } from '../services/menuCustomerAuth.js';

test('staff customer routes reject anonymous requests and enforce permissions before writes', async t => {
  t.mock.method(process, 'emitWarning', () => {});
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'menu-access-fixture-signing-secret';
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });
  let writes = 0;
  t.mock.method(Customer, 'findOneAndUpdate', async (filter, update) => {
    writes++;
    return { customerId: filter.customerId, email: 'fixture@example.invalid', ...update.$set };
  });
  let staff = { _id: 'fixture-staff', isActive: true, role: 'driver', sessionVersion: 0 };
  t.mock.method(User, 'findById', () => ({ select: async () => staff }));
  const app = express(); app.use(express.json()); app.use('/api/menus', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/menus/customers/customer`;
  const routes = [['GET','meal-profile'], ['POST','meal-profile'], ['GET','complete-profile'], ['GET','filemaker-raw'], ['GET','filemaker-layouts']];
  for (const [method, suffix] of routes) {
    const response = await fetch(`${base}/${suffix}`, { method });
    assert.equal(response.status, 401, `${method} ${suffix}`);
  }
  const token = jwt.sign({ id: 'fixture-staff', sessionVersion: 0 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const edit = () => fetch(`${base}/meal-profile`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ allergies: ['Milk'], unlimitedMeals: true }) });
  assert.equal((await edit()).status, 403);
  assert.equal(writes, 0);
  staff = { ...staff, role: 'admin', permissionsConfigured: true, permissions: { customers: false } };
  assert.equal((await edit()).status, 403, 'explicit permission denial overrides role defaults');
  assert.equal(writes, 0);
  staff = { ...staff, role: 'dispatcher', permissionsConfigured: false };
  const allowed = await edit();
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).data.allergies, ['Milk']);
  assert.equal(writes, 1);
});

test('email-only sign-in requires an active shared menu and has no code endpoints', async t => {
  const menuId = '507f1f77bcf86cd799439012';
  let requests = 0;
  t.mock.method(Menu, 'findOne', query => ({ select: () => ({ populate: () => ({ lean: async () => query['shareLink.token'] === 'valid-share' || !query['shareLink.token'] ? { _id: menuId } : null }) }) }));
  t.mock.method(menuSessions, 'start', async (email, id) => { requests++; assert.equal(id, menuId); return { token: 'scoped-menu-session', email, menuId: id }; });
  const app = express(); app.use(express.json()); app.use('/api/menus', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/api/menus/customer-auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('session', { email: 'customer@example.invalid', menuId })).status, 400);
  assert.equal((await post('session', { email: 'customer@example.invalid', menuId, shareToken: 'wrong-share' })).status, 410);
  assert.equal(requests, 0);
  const sent = await post('session', { email: 'customer@example.invalid', menuId, shareToken: 'valid-share' });
  assert.equal(sent.status, 200);
  assert.equal(sent.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await sent.json(), { success: true, data: { token: 'scoped-menu-session', email: 'customer@example.invalid', menuId } });
  assert.equal((await post('request', {})).status, 404);
  assert.equal((await post('verify', {})).status, 404);
});

test('a menu session is scoped to one email/menu and cannot edit staff fields or exceed meal allowances', async t => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'fixture-menu-customer-key-over-32-characters';
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const menuId = '507f1f77bcf86cd799439012';
  const itemId = '507f1f77bcf86cd799439013';
  const email = 'customer@example.invalid';
  let menuAvailable = true; let lookups = 0; let writes = 0; let stored;
  const menu = { _id: menuId, meals: [{ date: '2099-01-01', mealType: 'main', items: [{ _id: itemId, mealName: 'Offered meal' }] }] };
  t.mock.method(Menu, 'findOne', () => ({ select: () => ({ populate: () => ({ lean: async () => menuAvailable ? menu : null }) }) }));
  t.mock.method(Menu, 'findByIdAndUpdate', async () => ({}));
  t.mock.method(matter, 'getKitchenNutrition', async () => { lookups++; return {
    customer_id: 'verified-customer', customer_email: email, customer_name: 'Fixture Customer', subscription_id: 'verified-subscription',
    meal_frequency: 2, breakfast_included: false, active_delivery_dates: ['2099-01-01'], exclusions: [],
  }; });
  t.mock.method(Customer, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  t.mock.method(Record, 'findOne', () => ({ lean: async () => null, select: () => ({ lean: async () => null }) }));
  t.mock.method(Record, 'countDocuments', async () => 1);
  t.mock.method(Record, 'findOneAndUpdate', async (filter, update) => { writes++; stored = update.$set; return {}; });
  const app = express(); app.use(express.json()); app.use('/api/menus', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/menus`;
  const token = issueMenuSession(email, menuId);
  const get = (path, session) => fetch(base + path, { headers: session ? { 'X-Menu-Session': session } : {} });
  const post = (path, body, session) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Menu-Session': session } : {}) }, body: JSON.stringify(body) });
  const profile = `/customers/${email}/subscription-profile?menuId=${menuId}`;
  assert.equal((await get(profile)).status, 401);
  assert.equal((await post(`/customers/${email}/select-meals`, { weeklyMenuId: menuId, selections: [] })).status, 401);
  assert.equal((await post(`/customers/${email}/skip-pause-preview`, { menuId, dates: [] })).status, 401);
  assert.equal(lookups, 0);
  assert.equal((await get(profile.replace(email, 'other@example.invalid'), token)).status, 403);
  assert.equal((await get(profile + '&email=other@example.invalid', token)).status, 403);
  assert.equal((await get(profile.replace(menuId, itemId), token)).status, 403);
  assert.equal(lookups, 0);
  const allowed = await get(profile, token);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.equal((await allowed.json()).data.email, email);
  assert.equal((await post(`/customers/${email}/skip-pause-preview`, { menuId, dates: [] }, token)).status, 200);
  assert.equal((await post(`/customers/customer/meal-profile`, { allergies: [] }, token)).status, 401, 'customer credentials cannot enter staff editing');
  const path = `/customers/${email}/select-meals`;
  assert.equal((await post(path, { weeklyMenuId: menuId, selections: [], unlimitedMeals: true }, token)).status, 400);
  const selections = [{ date: '2099-01-01', mealType: 'main', menuItemId: itemId, quantity: 3 }];
  assert.equal((await post(path, { weeklyMenuId: menuId, selections }, token)).status, 400);
  assert.equal(writes, 0);
  assert.equal((await post(path, { weeklyMenuId: menuId, selections: [{ ...selections[0], quantity: 1, menuItemId: menuId }] }, token)).status, 400);
  const saved = await post(path, { weeklyMenuId: menuId, selections: [{ ...selections[0], quantity: 2, mealName: 'Untrusted name' }] }, token);
  assert.equal(saved.status, 200);
  assert.equal(writes, 1);
  assert.equal(stored.email, email);
  assert.equal(stored.selectedMeals[0].mealName, 'Offered meal');
  menuAvailable = false;
  assert.equal((await get(profile, token)).status, 410, 'disabling the menu revokes access even with a valid session');
});
