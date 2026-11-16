import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Traceability from './Traceability';
import api from '../utils/api';
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
const catalog = {
  api: [
    {
      id: 'one',
      method: 'GET',
      path: '/api/truckoom/vehicles',
      source: 'server/routes/truckoomApi.js:51',
      description: 'Tracker positions',
      responseKeys: ['data'],
      middlewareDeclarations: ['protect'],
    },
    { id: 'two', method: 'POST', path: '/api/test', source: 'server/server.js:1' },
  ],
  browser: [],
  boundaries: [],
  areas: [],
};
const activity = {
  retentionMinutes: 30,
  maxEvents: 2000,
  instanceId: 'test-process',
  startedAt: new Date().toISOString(),
  enabled: true,
  events: [
    {
      timestamp: new Date().toISOString(),
      event: 'http.completed',
      route: '/api/truckoom/vehicles',
      request_id: 'request-one',
      span_id: 'one',
      trace_id: 'trace-one',
      outcome: 'degraded',
      duration_ms: 12,
    },
    {
      timestamp: new Date().toISOString(),
      event: 'dependency.completed',
      dependency: 'truckoom',
      trace_id: 'trace-one',
      span_id: 'two',
      outcome: 'failed',
    },
  ],
};
let root, container;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockImplementation(async (path) => ({
    data: { data: path.endsWith('/catalog') ? catalog : activity },
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.clearAllMocks();
});
test('routes are searchable and activity opens the associated dependency trace', async () => {
  await act(async () => root.render(<Traceability />));
  expect(container.textContent).toContain('Tracker positions');
  const input = container.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'missing');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.textContent).toContain('No matching routes');
  const activityButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Recent activity',
  );
  await act(async () => activityButton.click());
  await act(async () => container.querySelector('.trace-event-link').click());
  expect(container.querySelector('.trace-chain').textContent).toContain('trace-one');
  expect(container.querySelector('.trace-chain').textContent).toContain('truckoom');
  expect(container.textContent).toContain('clear on restart');
});
test('failed load provides recovery and a subsequent refresh loads the map', async () => {
  api.get.mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<Traceability />));
  expect(container.querySelector('[role="alert"]').textContent).toContain('could not be loaded');
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Refresh')
      .click(),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('Tracker positions');
});
