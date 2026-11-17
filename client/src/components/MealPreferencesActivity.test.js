import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MealPreferences from './MealPreferences';
import api from '../utils/api';
import { installActivityCapture } from '../utils/activityCapture';
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let container, root, cleanup, capture, oldFetch, warn;
beforeEach(async () => {
  const profile = { mealPlan: 'Standard', mealPerDay: 2, breakfastInclude: false, mealSnack: false, snackCount: 0, unlimitedMeals: false, partner: null, allergies: [], dietaryRestrictions: [], mealExclusion: '', preferences: '' };
  api.get.mockImplementation(async path => ({ data: { success: true, data: path.includes('meal-profile') ? profile : [{ _id: 'fixture-partner', businessName: 'Fixture partner', menuSelectionEnabled: true }] } }));
  api.post.mockClear(); localStorage.setItem('token', 'fixture-session'); window.history.replaceState({}, '', '/customers');
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); oldFetch = window.fetch;
  capture = jest.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) }); window.fetch = capture;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  cleanup = installActivityCapture(); await act(async () => root.render(<MealPreferences customerId="fixture-customer" />));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Edit')).click());
});
afterEach(async () => { cleanup(); await act(async () => root.unmount()); container.remove(); localStorage.clear(); window.fetch = oldFetch; warn.mockRestore(); });
const events = () => capture.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
async function deliver() { await act(async () => window.dispatchEvent(new Event('pagehide'))); }
test('cancel records the value restored from the unsaved meal profile', async () => {
  const plan = [...container.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'Customized'));
  await act(async () => { plan.value = 'Customized'; plan.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Cancel')).click()); await deliver();
  expect(events().some(event => event.changes.some(change => change.field === 'Meal plan' && change.before === 'Customized' && change.after === 'Standard'))).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});
test('choosing a partner records its dependent unlimited-meals default without saving', async () => {
  const partner = [...container.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'fixture-partner'));
  await act(async () => { partner.value = 'fixture-partner'; partner.dispatchEvent(new Event('change', { bubbles: true })); }); await deliver();
  expect(events().some(event => event.changes.some(change => change.field === 'Unlimited meals' && change.before === 'false' && change.after === 'true'))).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});
