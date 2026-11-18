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
  const profileDetails = container.querySelector('details[aria-label="Partner contact details"]');
  expect(profileDetails.open).toBe(false);
  await act(async () => profileDetails.querySelector('summary').click());
  expect(profileDetails.open).toBe(true);
  await click('Edit');
  const formDetails = container.querySelector('form details');
  expect(formDetails.open).toBe(false);
  expect(formDetails.querySelector('summary').textContent.trim()).toBe('Details');
  await act(async () => formDetails.querySelector('summary').click());
  expect(formDetails.open).toBe(true);
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
  expect(form.textContent).not.toContain('Menu Selection Partner');
  expect(form.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
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

test('editing contact details does not send the retired switch or overwrite saved macro settings', async () => {
  const existing = {...legacy, menuSelectionEnabled: true, presetMacros: {C: 120, P: 90, F: 40}};
  api.get.mockImplementation(async path => ({data: {data: path === '/admin/partners' ? [existing] : []}}));
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<AdminPartners />));
  expect(container.textContent).not.toContain(' · Menu Selection');
  await click('Edit');
  const form = container.querySelector('form');
  expect(form.textContent).not.toContain('Menu Selection Partner');
  expect(form.textContent).not.toContain('Carbs (C)');
  expect(form.textContent).not.toContain('Protein (P)');
  expect(form.textContent).not.toContain('Fat (F)');
  await submit();
  expect(api.patch.mock.calls[0][1]).not.toHaveProperty('menuSelectionEnabled');
  expect(api.patch.mock.calls[0][1]).not.toHaveProperty('presetMacros');
});
