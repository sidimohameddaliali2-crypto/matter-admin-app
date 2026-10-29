import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import io from 'socket.io-client';
import authReducer from '../store/slices/authSlice';
import { SocketProvider } from './SocketContext';

jest.mock('socket.io-client', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../utils/api', () => ({ __esModule: true, default: {} }));

global.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let container;
let sockets;
const user = { _id: 'fixture-driver', role: 'driver' };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'original-token');
  localStorage.setItem('user', JSON.stringify(user));
  localStorage.setItem('offline-driver-state', 'pending-proof-reference');
  sockets = [];
  io.mockReset().mockImplementation(() => {
    const handlers = new Map();
    const socket = {
      handlers,
      on: jest.fn((event, handler) => { handlers.set(event, handler); return socket; }),
      off: jest.fn((event) => { handlers.delete(event); return socket; }),
      close: jest.fn()
    };
    sockets.push(socket);
    return socket;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

const renderSession = async (token = 'original-token') => {
  const store = configureStore({
    reducer: { auth: authReducer },
    preloadedState: { auth: { user: token ? user : null, token, isLoading: false, error: null } }
  });
  await act(async () => root.render(
    <Provider store={store}><SocketProvider><div>Driver app</div></SocketProvider></Provider>
  ));
  return store;
};

test('revocation signs out staff without clearing unrelated local storage or offline databases', async () => {
  const clear = jest.spyOn(Storage.prototype, 'clear');
  const originalIndexedDB = global.indexedDB;
  const deleteDatabase = jest.fn();
  global.indexedDB = { deleteDatabase };
  try {
    const store = await renderSession();
    const socket = sockets[0];
    await act(async () => socket.handlers.get('auth:revoked')());
    expect(store.getState().auth.token).toBeNull();
    expect(store.getState().auth.user).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
    expect(localStorage.getItem('offline-driver-state')).toBe('pending-proof-reference');
    expect(clear).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.handlers.has('auth:revoked')).toBe(false);
  } finally {
    global.indexedDB = originalIndexedDB;
  }
});

test('ordinary network errors retain the session; an authentication rejection signs it out', async () => {
  const store = await renderSession();
  const handler = sockets[0].handlers.get('connect_error');
  await act(async () => handler(new Error('xhr poll error')));
  expect(store.getState().auth.token).toBe('original-token');
  await act(async () => handler(new Error('Not authorized')));
  expect(store.getState().auth.token).toBeNull();
});

test('late events from a replaced socket cannot sign out a newer login', async () => {
  const store = await renderSession();
  const oldSocket = sockets[0];
  const lateRevocation = oldSocket.handlers.get('auth:revoked');
  localStorage.setItem('token', 'new-login-token');
  await act(async () => {
    store.dispatch({
      type: 'auth/login/fulfilled', payload: { data: { user, token: 'new-login-token' } }
    });
    // A queued event can run before React has rendered the new login.
    lateRevocation();
  });
  expect(oldSocket.close).toHaveBeenCalledTimes(1);
  expect(oldSocket.handlers.has('auth:revoked')).toBe(false);
  expect(io).toHaveBeenLastCalledWith(expect.any(String), { auth: { token: 'new-login-token' } });
  await act(async () => lateRevocation());
  expect(store.getState().auth.token).toBe('new-login-token');
  await act(async () => sockets[1].handlers.get('auth:revoked')());
  expect(store.getState().auth.token).toBeNull();
});

test('signed-out staff do not open a socket', async () => {
  await renderSession(null);
  expect(io).not.toHaveBeenCalled();
});
