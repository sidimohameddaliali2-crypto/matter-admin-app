import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import AdminPartners from './AdminPartners';
import api from '../utils/api';

jest.mock('react-redux', () => ({useSelector: fn => fn({auth: {user: {role: 'admin'}}})}));
jest.mock('../utils/api', () => ({__esModule: true, default: {get: jest.fn(), post: jest.fn(), patch: jest.fn()}}));
jest.mock('../utils/activityCapture', () => ({recordActivityChange: jest.fn()}));
jest.mock('jspdf', () => jest.fn());
jest.mock('jspdf-autotable', () => ({}));
global.IS_REACT_ACT_ENVIRONMENT = true;

const legacy = {_id: 'partner', businessName: 'Fixture Cafe', businessType: 'cafe', contactName: 'Login Contact', email: 'login@example.com', phone: '+971 50 111 1111', isActive: true};
let container, root;
beforeEach(async () => {
  jest.clearAllMocks();
  api.get.mockImplementation(async path => ({data: {data: path === '/admin/partners' ? [legacy] : []}}));
  api.patch.mockImplementation(async (path, payload) => ({data: {data: {...legacy, ...payload}}}));
  api.post.mockImplementation(async (path, payload) => ({data: {data: {...legacy, ...payload, _id: 'new-partner'}}}));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<AdminPartners />));
});
afterEach(async () => {await act(async () => root.unmount()); container.remove();});
const click = async text => act(async () => {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === text);
  expect(button).toBeTruthy(); button.click();
});
const setInput = async (selector, value) => act(async () => {
  const input = container.querySelector(selector); expect(input).toBeTruthy();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', {bubbles: true}));
});
const submit = async () => act(async () => container.querySelector('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));

test('admin can save, view, reopen and clear optional partner contacts on a legacy profile', async () => {
  expect(container.querySelector('[aria-label="Partner contacts"]').textContent).toContain('Not provided');
  await click('Edit');
  expect(container.querySelectorAll('fieldset')).toHaveLength(3);
  const values = {
    pointOfContact: {fullName: 'Service Person', email: 'service@example.com', phone: '+971 50 222 2222'},
    financeContact: {fullName: 'Finance Person', email: 'finance@example.com', phone: '+971 50 333 3333'},
    ownerContact: {fullName: 'Business Owner', email: 'owner@example.com', phone: '+971 50 444 4444'}
  };
  for (const [role, fields] of Object.entries(values)) for (const [field, value] of Object.entries(fields)) {
    expect(container.querySelector(`#${role}-${field}`).required).toBe(false);
    await setInput(`#${role}-${field}`, value);
  }
  await submit();
  expect(api.patch).toHaveBeenCalledWith('/admin/partners/partner', expect.objectContaining(values));
  const profile = container.querySelector('[aria-label="Partner contacts"]');
  for (const fields of Object.values(values)) for (const value of Object.values(fields)) expect(profile.textContent).toContain(value);
  await click('Edit');
  expect(container.querySelector('#financeContact-email').value).toBe('finance@example.com');
  await setInput('#financeContact-email', ''); await submit();
  expect(api.patch.mock.calls[1][1].financeContact).toEqual({...values.financeContact, email: ''});
  expect(api.patch.mock.calls[1][1].ownerContact).toEqual(values.ownerContact);
  expect(container.querySelector('[aria-label="Partner contacts"]').textContent).not.toContain('finance@example.com');
  expect(container.textContent).toContain('Login Contact');
});

test('creating a partner permits all three optional contacts to be blank', async () => {
  await click('Add partner');
  const form = container.querySelector('form');
  expect(form.querySelectorAll('fieldset input')).toHaveLength(9);
  for (const input of form.querySelectorAll('fieldset input')) expect(input.required).toBe(false);
  await setInput('[name="businessName"]', 'New Cafe');
  await setInput('[name="contactName"]', 'Login Person');
  await setInput('[name="email"]', 'new@example.com');
  await setInput('[name="password"]', 'fixture-password');
  await submit();
  expect(api.post).toHaveBeenCalledWith('/admin/partners', expect.objectContaining({
    pointOfContact: {fullName: '', email: '', phone: ''},
    financeContact: {fullName: '', email: '', phone: ''},
    ownerContact: {fullName: '', email: '', phone: ''}
  }));
});
