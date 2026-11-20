import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import MatterImportControl, { importProgress, canImportMatter } from './MatterImportControl';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ get: jest.fn(), post: jest.fn() }));

test('calendar discovery never claims 100 percent or completion before delivery writes', () => {
  expect(importProgress({ status: 'running', progress: { phase: 'checking', completed: 354, total: 354 } }))
    .toEqual({ percent: 75, text: 'Checking subscription calendars: 354 / 354' });
  expect(importProgress({ status: 'queued' }).percent).toBe(0);
  expect(importProgress({ status: 'completed' }).percent).toBe(100);
  expect(importProgress({ status: 'incomplete' }).percent).toBeLessThan(100);
});

test('reload restores the saved running job and terminal progress refreshes the delivery list once', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  const running = { id: 'saved-job', date: '2026-11-22', status: 'running', progress: { phase: 'checking', completed: 100, total: 354 } };
  api.get.mockResolvedValueOnce({ data: { data: running } })
    .mockResolvedValue({ data: { data: { ...running, status: 'completed', result: { created: 11 } } } });
  const node = document.createElement('div');
  const root = createRoot(node);
  const completed = jest.fn();
  try {
    await act(async () => root.render(<MatterImportControl role="dispatcher" date="2026-11-22" onComplete={completed} />));
    expect(node.textContent).toContain('100 / 354');
    expect(node.querySelector('button').disabled).toBe(true);
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(node.textContent).toContain('11 created');
    expect(node.textContent).toContain('Saturday');
    expect(completed).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(completed).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    jest.useRealTimers();
  }
});

test('initial control and interrupted progress do not imply success', () => {
  expect(renderToStaticMarkup(<MatterImportControl role="dispatcher" date="2026-11-22" onComplete={() => {}} />)).toContain('Import from Matter');
  expect(importProgress({ status: 'failed', message: 'Worker interrupted. Retry.' }).text).toContain('interrupted');
  expect(importProgress({ status: 'incomplete', message: 'Import incomplete.' }).text).toBe('Import incomplete.');
});

test('incomplete result retains failure and review details and offers a deliberate retry', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.get.mockResolvedValue({ data: { data: { id: 'incomplete-job', date: '2026-11-22', status: 'incomplete',
    message: 'Import incomplete.', result: { created: 3, failed: 1, noDeliveryWindow: 2, requiresReview: true,
      errors: [{ subscriptionId: 'synthetic', message: 'Unable to verify delivery schedule' }] } } } });
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<MatterImportControl role="dispatcher" date="2026-11-22" onComplete={() => {}} />));
    expect(node.textContent).toContain('Import incomplete.');
    expect(node.textContent).toContain('3 created');
    expect(node.textContent).toContain('1 failed');
    expect(node.textContent).toContain('2 without a delivery window');
    expect(node.textContent).toContain('Some deliveries need review');
    expect(node.textContent).toContain('Unable to verify delivery schedule');
    expect(node.querySelector('button').textContent).toContain('Retry');
    expect(node.querySelector('button').disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

test('changing the selected date ignores the old date’s late progress response', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  let release;
  api.get.mockReset();
  api.get.mockReturnValueOnce(new Promise(resolve => { release = resolve; }))
    .mockResolvedValue({ data: { data: { id: 'new-job', date: '2026-11-23', status: 'queued' } } });
  const node = document.createElement('div');
  const root = createRoot(node);
  const onComplete = jest.fn();
  try {
    await act(async () => root.render(<MatterImportControl role="dispatcher" date="2026-11-22" onComplete={onComplete} />));
    await act(async () => root.render(<MatterImportControl role="dispatcher" date="2026-11-23" onComplete={onComplete} />));
    await act(async () => release({ data: { data: { id: 'old-job', date: '2026-11-22', status: 'completed' } } }));
    expect(node.textContent).toContain('2026-11-23');
    expect(node.textContent).not.toContain('2026-11-22');
    expect(onComplete).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

test('drivers and non-import staff never mount the control or poll import status', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.get.mockReset();
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    for (const role of ['driver', 'viewer', 'kitchen', 'store_keeper', undefined]) {
      await act(async () => root.render(<MatterImportControl role={role} date="2026-11-22" onComplete={() => {}} />));
      expect(node.textContent).toBe('');
    }
    expect(api.get).not.toHaveBeenCalled();
    for (const role of ['admin', 'super_admin', 'dispatcher', 'manager']) expect(canImportMatter(role)).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

test('an interrupted job displays saved phase, checked count and available write counts on reload', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.get.mockResolvedValue({ data: { data: { id: 'interrupted-job', date: '2026-11-22', status: 'failed',
    message: 'Worker was interrupted. Review saved progress and retry.',
    progress: { phase: 'importing', completed: 5, total: 11, created: 3, alreadyExisted: 1, failed: 1, noDeliveryWindow: 0,
      customersCreated: 2, writeFailed: 1, discoveryFailed: 0 } } } });
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<MatterImportControl role="dispatcher" date="2026-11-22" onComplete={() => {}} />));
    expect(node.textContent).toContain('Last saved progress: Importing eligible deliveries: 5 / 11');
    expect(node.textContent).toContain('3 created');
    expect(node.textContent).toContain('1 already imported');
    expect(node.textContent).toContain('1 failed');
    expect(node.textContent).toContain('0 without a delivery window');
    expect(node.textContent).toContain('2 customer records created');
    expect(node.textContent).toContain('1 delivery write failures');
    expect(node.textContent).toContain('0 discovery failures');
    expect(node.textContent).toContain('write just before interruption may not be included');
    expect(node.textContent).not.toContain('0 already scheduled');
    expect(node.querySelector('button').textContent).toContain('Retry');
  } finally { await act(async () => root.unmount()); }
});

test('a denied status request stops polling and displays a permission message', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  api.get.mockReset();
  api.get.mockRejectedValue({ response: { status: 403 } });
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<MatterImportControl role="dispatcher" date="2026-11-22" onComplete={() => {}} />));
    expect(node.textContent).toContain('do not have permission');
    expect(node.textContent).not.toContain('may still be running');
    await act(async () => { jest.advanceTimersByTime(9000); });
    expect(api.get).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); jest.useRealTimers(); }
});
