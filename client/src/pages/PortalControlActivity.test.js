import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MemberPortal from './MemberPortal';
import PartnerPortal from './PartnerPortal';
import MemberExclusionPicker from '../components/MemberExclusionPicker';
import memberApi from '../utils/memberApi';
import partnerApi from '../utils/partnerApi';
import { installActivityCapture } from '../utils/activityCapture';

const mockState = { memberAuth: { member: { _id: 'member-fixture', name: 'Fixture member', dietaryExclusions: '', partner: { businessName: 'Fixture partner' } } }, partnerAuth: { partner: { _id: 'partner-fixture', businessName: 'Fixture partner' } } };
jest.mock('react-redux', () => ({ useSelector: fn => fn(mockState), useDispatch: () => jest.fn() }));
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock('../utils/memberApi', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));
jest.mock('../utils/partnerApi', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('jspdf', () => jest.fn());
jest.mock('qrcode.react', () => ({ QRCodeCanvas: () => null }));
global.IS_REACT_ACT_ENVIRONMENT = true;
const meal = { _id: 'fixture-meal', name: 'Fixture bowl', mealType: 'bowl', price: 30 };
let container, root, cleanup, fetchCapture;
const observations = () => fetchCapture.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
async function deliver() { await act(async () => { jest.advanceTimersByTime(2000); for (let i = 0; i < 8; i++) await Promise.resolve(); }); }
async function click(text) {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent.trim() === text);
  expect(button).toBeTruthy(); await act(async () => button.click());
}
beforeEach(() => {
  jest.useFakeTimers(); jest.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.clear();
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  fetchCapture = jest.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) }); window.fetch = fetchCapture;
  memberApi.get.mockImplementation(async path => ({ data: { success: true, data: path === '/member/orders' ? [] : [meal] } }));
  memberApi.post.mockClear(); partnerApi.post.mockClear();
  const order = { _id: 'fixture-order', deliveryDate: '2099-01-05T00:00:00Z', deliveryTime: 'Morning · 5–6am', status: 'submitted', editable: true, lines: [{ menuItem: meal, quantity: 2, unitPrice: 30 }] };
  partnerApi.get.mockImplementation(async path => ({ data: { success: true, data: path === '/partner/orders' ? [order] : [meal] } }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  cleanup?.(); await act(async () => root.unmount()); container.remove(); localStorage.clear(); jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
});
async function mountPortal(scheme, Component) {
  window.history.replaceState({}, '', `/${scheme}/portal`);
  localStorage.setItem(`${scheme}Token`, `${scheme}-session`); localStorage.setItem(`${scheme}User`, JSON.stringify({ _id: `${scheme}-fixture` }));
  cleanup = installActivityCapture(); await act(async () => root.render(<Component />)); await deliver();
  expect(observations()).toHaveLength(0);
}
test('member quantity buttons record successive unsaved choices with member authentication', async () => {
  await mountPortal('member', MemberPortal);
  const add = [...container.querySelectorAll('button')].find(node => node.textContent.trim() === '+');
  expect(add).toBeTruthy();
  await act(async () => { add.click(); add.click(); });
  await click('−'); await deliver();
  const quantity = observations().filter(event => event.form.field.includes('quantity'));
  expect(quantity.map(event => [event.changes[0].before, event.changes[0].after])).toEqual([['0', '1'], ['1', '2'], ['2', '1']]);
  expect(quantity.every(event => event.stage === 'form_edited' && !event.actor)).toBe(true);
  expect(fetchCapture.mock.calls[0][0]).toContain('/traceability/capture/member');
  expect(fetchCapture.mock.calls[0][1].headers.Authorization).toBe('Bearer member-session');
  expect(memberApi.post).not.toHaveBeenCalled();
});
test('member date buttons record changed dates without submitting an order', async () => {
  await mountPortal('member', MemberPortal);
  const nextDate = container.querySelectorAll('button[aria-label^="Delivery date "]')[1];
  expect(nextDate).toBeTruthy(); await act(async () => nextDate.click()); await deliver();
  const change = observations().find(event => event.form.field === 'Delivery date');
  expect(change.changes[0].before).not.toBe(change.changes[0].after);
  expect(change.changes[0].after).toBe(nextDate.getAttribute('aria-label').slice('Delivery date '.length));
  expect(memberApi.post).not.toHaveBeenCalled();
});
test('member custom view and order-period choices retain their before and after values', async () => {
  await mountPortal('member', MemberPortal);
  await click('My orders'); await click('Past'); await deliver();
  expect(observations().map(event => event.changes[0])).toEqual([
    { field: 'Portal view', before: 'Menu', after: 'My orders', redacted: false },
    { field: 'Orders filter', before: 'Upcoming', after: 'Past', redacted: false },
  ]);
});
test('same-named menu items keep distinct identities in member quantity history', async () => {
  memberApi.get.mockImplementation(async path => ({ data: { success: true, data: path === '/member/orders' ? [] : [meal, { ...meal, _id: 'another-meal' }] } }));
  await mountPortal('member', MemberPortal);
  const buttons = [...container.querySelectorAll('button')].filter(button => button.textContent === '+');
  await act(async () => buttons[0].click()); await act(async () => buttons[1].click()); await deliver();
  const quantity = observations().filter(event => event.form.field.includes('quantity'));
  expect(quantity).toHaveLength(2);
  expect(new Set(quantity.map(event => event.form.field)).size).toBe(2);
  expect(quantity[0].form.field).toContain('fixture-meal'); expect(quantity[1].form.field).toContain('another-meal');
});
test('partner existing-order quantity and window changes are captured before saving or cancel', async () => {
  await mountPortal('partner', PartnerPortal);
  await click('My Orders'); await click('Edit meals'); await deliver(); fetchCapture.mockClear();
  const add = container.querySelector('button[aria-label="Add one"]'); expect(add).toBeTruthy();
  await act(async () => { add.click(); add.click(); });
  await click('Morning · 7–10am'); await deliver();
  const quantity = observations().filter(event => event.form.field.includes('quantity'));
  expect(quantity.map(event => [event.changes[0].before, event.changes[0].after])).toEqual([['2', '3'], ['3', '4']]);
  expect(observations().find(event => event.form.field === 'Delivery window').changes[0]).toMatchObject({ before: 'Morning · 5–6am', after: 'Morning · 7–10am' });
  expect(fetchCapture.mock.calls[0][1].headers.Authorization).toBe('Bearer partner-session');
  expect(partnerApi.post).not.toHaveBeenCalled();
});
test('dietary checkbox edits keep their medical choice out of observation labels and values', async () => {
  function ExclusionFixture() { const [value, setValue] = React.useState(''); return <MemberExclusionPicker value={value} onChange={setValue} />; }
  await mountPortal('member', ExclusionFixture);
  const checkbox = [...container.querySelectorAll('label')].find(label => label.textContent === 'All Sea Food').querySelector('input');
  await act(async () => checkbox.click()); await deliver();
  expect(observations()).toHaveLength(1);
  expect(observations()[0].changes[0]).toEqual({ field: 'Dietary exclusions', before: '[Not recorded]', after: '[Not recorded]', redacted: true });
  expect(JSON.stringify(observations())).not.toContain('All Sea Food');
});
