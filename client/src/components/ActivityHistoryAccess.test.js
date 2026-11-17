import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import authReducer, { login, refreshCurrentUser } from '../store/slices/authSlice';
import api from '../utils/api';

// CRA's older Jest resolver cannot follow the installed router's package export
// map. Use its real CommonJS implementation rather than replacing navigation.
jest.mock('react-router-dom', () => require('../../node_modules/react-router/dist/development/index.js'), { virtual: true });

// React Router uses the standard text encoder, which jsdom does not provide.
global.TextEncoder = require('util').TextEncoder;
const { MemoryRouter, Routes, Route } = require('react-router-dom');
const { default: ActivityHistoryRoute, AuthBootstrap } = require('./ActivityHistoryAccess');

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));

const admin = { _id: 'fixture-reader', role: 'admin', profile: { firstName: 'Example' }, permissions: { dashboard: true } };
const approved = { ...admin, canViewActivityHistory: true };
const denied = { ...admin, canViewActivityHistory: false };
const response = (user) => ({ data: { success: true, data: { user } } });
let root;
let container;
let testStore;
const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const createStore = (user = admin, token = 'fixture-session') => {
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
  if (user) localStorage.setItem('user', JSON.stringify(user));
  else localStorage.removeItem('user');
  return configureStore({ reducer: { auth: authReducer }, preloadedState: { auth: { user, token, isLoading: false, error: null } } });
};
const render = async (path = '/traceability') => act(async () => root.render(
  <Provider store={testStore}>
    <MemoryRouter initialEntries={[path]}>
      <AuthBootstrap />
      <Routes>
        <Route path="/traceability" element={<ActivityHistoryRoute fallback={<p>Access denied</p>}><p>Private activity history</p></ActivityHistoryRoute>} />
        <Route path="/dashboard" element={<p>Dashboard content</p>} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>
  </Provider>,
));

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  testStore = createStore();
  api.get.mockResolvedValue(response(approved));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  jest.resetAllMocks();
});

test('allows an approved ordinary admin after checking the authenticated server response once', async () => {
  await render();
  expect(container.textContent).toBe('Private activity history');
  expect(testStore.getState().auth.user.canViewActivityHistory).toBe(true);
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledWith('/auth/me');
});

test.each(['admin', 'super_admin'])('denies an unapproved %s even when a saved login claimed approval', async (role) => {
  testStore = createStore({ ...approved, role });
  const pending = defer();
  api.get.mockReturnValueOnce(pending.promise);
  await render();
  expect(container.textContent).toContain('Checking access');
  expect(container.textContent).not.toContain('Private activity history');
  await act(async () => pending.resolve(response({ ...denied, role })));
  expect(container.textContent).toBe('Access denied');
  expect(container.textContent).not.toContain('Private activity history');
});

test.each([undefined, 'true'])('requires the boolean true rather than approval value %s', async (approval) => {
  api.get.mockResolvedValue(response({ ...admin, role: 'super_admin', canViewActivityHistory: approval }));
  await render();
  expect(container.textContent).toBe('Access denied');
});

test('hides the page if the current authenticated user loses explicit approval', async () => {
  await render();
  expect(container.textContent).toBe('Private activity history');
  await act(async () => testStore.dispatch(refreshCurrentUser.fulfilled(denied, 'fixture-refresh')));
  expect(container.textContent).toBe('Access denied');
});

test('closes open history immediately on a cross-tab account change and sends cross-tab logout to login', async () => {
  await render();
  expect(container.textContent).toBe('Private activity history');
  const pending = defer();
  api.get.mockReturnValueOnce(pending.promise);
  await act(async () => {
    localStorage.setItem('token', 'other-fixture-session');
    localStorage.setItem('user', JSON.stringify({ ...denied, _id: 'fixture-other-account' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'token', storageArea: localStorage }));
  });
  expect(container.textContent).toContain('Checking access');
  expect(container.textContent).not.toContain('Private activity history');
  await act(async () => pending.resolve(response({ ...denied, _id: 'fixture-other-account' })));
  expect(container.textContent).toBe('Access denied');
  await act(async () => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
  });
  expect(container.textContent).toBe('Login page');
});

test('waits on a direct link with an old unknown flag, then keeps approval after reload', async () => {
  const pending = defer();
  api.get.mockReturnValueOnce(pending.promise);
  await render();
  expect(container.textContent).toContain('Checking access');
  expect(container.textContent).not.toMatch(/Access denied|Login page|Private activity history/);
  await act(async () => pending.resolve(response(approved)));
  expect(container.textContent).toBe('Private activity history');
  const stored = JSON.parse(localStorage.getItem('user'));
  expect(stored.canViewActivityHistory).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(container);
  testStore = createStore(stored, localStorage.getItem('token'));
  await render();
  expect(container.textContent).toBe('Private activity history');
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('accepts the approval supplied at login and verifies it when history is opened', async () => {
  testStore = createStore(null, null);
  api.post.mockResolvedValue({ data: { success: true, data: { user: approved, token: 'new-fixture-session' } } });
  await testStore.dispatch(login({ email: 'fixture@example.test', password: 'fixture-password' })).unwrap();
  expect(testStore.getState().auth.user.canViewActivityHistory).toBe(true);
  await render();
  expect(container.textContent).toBe('Private activity history');
});

test('does not show history when access cannot be checked and lets the user retry', async () => {
  testStore = createStore(approved);
  api.get.mockRejectedValueOnce(new Error('offline'));
  await render();
  expect(container.querySelector('[role="alert"]').textContent).toContain('Could not check access');
  expect(container.textContent).not.toContain('Private activity history');
  await act(async () => container.querySelector('button').click());
  expect(container.textContent).toBe('Private activity history');
});

test('sends a visitor with no staff session to login without checking private access', async () => {
  testStore = createStore(null, null);
  await render();
  expect(container.textContent).toBe('Login page');
  expect(api.get).not.toHaveBeenCalled();
});

test('leaves unrelated pages visible and preserves the existing background user refresh', async () => {
  const pending = defer();
  api.get.mockReturnValueOnce(pending.promise);
  await render('/dashboard');
  expect(container.textContent).toBe('Dashboard content');
  expect(api.get).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(response(denied)));
  expect(container.textContent).toBe('Dashboard content');
  expect(testStore.getState().auth.user.canViewActivityHistory).toBe(false);
});
