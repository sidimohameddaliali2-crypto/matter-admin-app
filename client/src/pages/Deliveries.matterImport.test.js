import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Deliveries from './Deliveries';
import api from '../utils/api';

jest.mock('../utils/api', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('react-redux', () => ({ useSelector: selector => selector({ auth: { user: { role: 'dispatcher' } } }) }));
jest.mock('react-router-dom', () => ({ Link: ({ children }) => children, useSearchParams: () => [new URLSearchParams()] }), { virtual: true });
jest.mock('../contexts/SocketContext', () => ({ useSocket: () => ({ socket: null }) }));
jest.mock('../utils/activityCapture', () => ({ recordActivityChange: jest.fn() }));
jest.mock('../components/deliveries/PrintConfigModal', () => () => null);
jest.mock('../components/deliveries/DeliveryDetailModal', () => () => null);

test.each(['completed', 'incomplete', 'failed'])('a %s job refreshes rows once, survives a control remount, and leaves the sheet usable', async status => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-22T08:00:00Z'));
  api.get.mockReset(); api.post.mockReset();
  let job = { id: 'terminal-job', date: '2026-11-22', status, message: `Import ${status}.`, progress: { phase: 'importing', completed: 1, total: 1, created: 1 } };
  let rowRequests = 0;
  api.get.mockImplementation(async path => {
    if (path === '/deliveries') {
      rowRequests++;
      return { data: { success: true, data: { deliveries: [] } } };
    }
    if (path === '/matter/import-deliveries/status') return { data: { success: true, data: { ...job } } };
    return { data: { data: [] } };
  });
  api.post.mockImplementation(async path => {
    if (path === '/matter/import-deliveries') { job = { id: 'retry-job', date: '2026-11-22', status: 'queued' }; return { data: { data: job } }; }
    return { data: { data: { updated: 0 } } };
  });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Deliveries />));
    expect(node.textContent).toContain('Deliveries');
    expect(rowRequests).toBe(2); // Initial sheet read plus one quiet completion read.
    expect(api.post.mock.calls.filter(([path]) => path === '/matter/standardize-deliveries')).toHaveLength(1);
    for (let i = 0; i < 3; i++) await act(async () => { jest.advanceTimersByTime(3000); });
    expect(rowRequests).toBe(2);
    expect(node.textContent).not.toContain('Loading deliveries...');
    // The ordinary Refresh button deliberately goes through the page spinner,
    // remounting the child. Its terminal notification must still be idempotent.
    await act(async () => node.querySelector('button[title="Refresh"]').click());
    expect(rowRequests).toBe(3);
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(rowRequests).toBe(3);
    const importButton = [...node.querySelectorAll('button')].find(button => /Retry Matter import|Import from Matter/.test(button.textContent));
    expect(importButton).toBeDefined();
    expect(importButton.disabled).toBe(false);
    await act(async () => importButton.click());
    expect(api.post).toHaveBeenCalledWith('/matter/import-deliveries', { date: '2026-11-22' }, { timeout: 15000 });
    expect(node.textContent).toContain('Import running');
    expect(rowRequests).toBe(3);
  } finally {
    await act(async () => root.unmount());
    confirm.mockRestore();
    jest.useRealTimers();
  }
});

test.each(['completed', 'incomplete', 'failed'])('a %s job keeps loaded rows, selection and import controls after quiet-refresh failures', async status => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-22T08:00:00Z'));
  api.get.mockReset(); api.post.mockReset();
  const row = { _id: 'synthetic-retained', customerId: 'SYNTHETIC', customerName: 'Synthetic retained customer',
    type: 'Delivery', company: 'Matter', status: 'pending', address: 'Synthetic address', zone: 'Test zone', scheduledTime: '2026-11-22T01:00:00Z' };
  let job = { id: 'terminal-job', date: '2026-11-22', status, message: `Import ${status}.`,
    progress: { phase: 'importing', completed: 1, total: 1, created: 1 } };
  let rowRequests = 0;
  let rejectRefresh;
  api.get.mockImplementation(path => {
    if (path === '/deliveries') {
      rowRequests++;
      if (rowRequests === 2) return new Promise((_resolve, reject) => { rejectRefresh = reject; });
      if (rowRequests === 3) return Promise.reject({ response: { data: { message: 'Synthetic temporary outage' } } });
      return Promise.resolve({ data: { success: true, data: { deliveries: [row] } } });
    }
    if (path === '/matter/import-deliveries/status') return Promise.resolve({ data: { success: true, data: { ...job } } });
    return Promise.resolve({ data: { data: [] } });
  });
  api.post.mockImplementation(async path => {
    if (path === '/matter/import-deliveries') { job = { id: 'retry-job', date: '2026-11-22', status: 'queued' }; return { data: { data: job } }; }
    return { data: { data: { updated: 0 } } };
  });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  const node = document.createElement('div');
  const root = createRoot(node);
  const retryRows = () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Retry sheet refresh');
  try {
    await act(async () => root.render(<Deliveries />));
    expect(rowRequests).toBe(2);
    await act(async () => node.querySelector('input[type="checkbox"]').click());
    expect(node.textContent).toContain('Print (1)');
    await act(async () => rejectRefresh({ response: { data: { message: 'Synthetic temporary outage' } } }));
    expect(node.textContent).toContain('Showing the last loaded sheet');
    expect(node.textContent).toContain('Synthetic retained customer');
    expect(node.textContent).toContain('Print (1)');
    expect(node.textContent).toContain(`Import ${status}.`);
    expect(node.textContent).not.toContain('Error loading deliveries');
    expect(node.querySelector('button[title="Refresh"]')).not.toBeNull();
    expect(retryRows()).toBeDefined();
    await act(async () => { jest.advanceTimersByTime(6000); });
    expect(rowRequests).toBe(2);
    await act(async () => retryRows().click());
    expect(rowRequests).toBe(3);
    expect(node.textContent).toContain('Synthetic retained customer');
    expect(node.textContent).toContain('Print (1)');
    expect(retryRows()).toBeDefined();
    await act(async () => retryRows().click());
    expect(rowRequests).toBe(4);
    expect(retryRows()).toBeUndefined();
    expect(node.textContent).not.toContain('Showing the last loaded sheet');
    expect(node.textContent).toContain('Print (1)');
    expect(api.post.mock.calls.filter(([path]) => path === '/matter/standardize-deliveries')).toHaveLength(1);
    const retryImport = [...node.querySelectorAll('button')].find(button => /Retry Matter import|Import from Matter/.test(button.textContent));
    expect(retryImport.disabled).toBe(false);
    await act(async () => retryImport.click());
    expect(node.textContent).toContain('Import running');
    expect(node.textContent).toContain('Synthetic retained customer');
  } finally {
    await act(async () => root.unmount());
    confirm.mockRestore(); errorLog.mockRestore(); jest.useRealTimers();
  }
});
