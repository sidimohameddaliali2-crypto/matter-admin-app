import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ActionEditor from './ActionEditor';
import api from '../../utils/api';
jest.mock('../../utils/api', () => ({ __esModule: true, default: { patch: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, onSaved;
const action = { _id: 'action', version: 3, ownerId: 'me', status: 'assigned', dueAt: '2026-11-07T10:00:00Z', promisedDueAt: '2026-11-07T10:00:00Z', description: 'Verify the requested change', history: [] };
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent.trim() === text);
async function fill(node, value) {
  await act(async () => {
    const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function render(overrides = {}) { await act(async () => root.render(<ActionEditor action={action} owners={[{ userId: 'me', displayName: 'Me' }, { userId: 'other', displayName: 'Other staff' }]} capabilities={{ workActions: true }} currentUserId="me" onSaved={onSaved} onClose={() => {}} {...overrides}/>)); }
beforeEach(() => { jest.clearAllMocks(); onSaved = jest.fn(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test('waiting requires a reason and next check and retains the original promise', async () => {
  await render(); await fill(container.querySelector('[aria-label="Action status"]'), 'waiting');
  expect(button('Save action update').disabled).toBe(true);
  await fill(container.querySelector('[aria-label="Action update reason"]'), 'Waiting on confirmation from the relevant team');
  await fill(container.querySelector('[aria-label="Next check in Dubai"]'), '2026-11-07T15:00');
  expect(container.textContent).toContain('Original customer promise');
  expect(button('Save action update').disabled).toBe(false);
  api.patch.mockResolvedValue({ data: { data: { action: { ...action, version: 4, status: 'waiting' } } } });
  await act(async () => button('Save action update').click());
  expect(api.patch).toHaveBeenCalledWith('/customer-service/actions/action', expect.objectContaining({ version: 3, status: 'waiting', nextCheckAt: '2026-11-07T11:00:00.000Z', dueAt: '2026-11-07T10:00:00.000Z' }));
  expect(onSaved).toHaveBeenCalled();
});
test('completion requires actual result plus confirmation of the requested effect', async () => {
  await render(); await fill(container.querySelector('[aria-label="Action status"]'), 'completed');
  expect(button('Save action update').disabled).toBe(true);
  await fill(container.querySelector('[aria-label="Action result and evidence"]'), 'Verified the changed date against the dated source record');
  expect(button('Save action update').disabled).toBe(true);
  await act(async () => container.querySelector('input[type="checkbox"]').click());
  expect(button('Save action update').disabled).toBe(false);
});
test('another reviewers action is read-only even when visible as case context', async () => {
  await render({ action: { ...action, ownerId: 'other' } });
  expect(container.textContent).toContain('read-only in your service scope');
  expect(button('Save action update')).toBeUndefined();
});
test('supervisor ownership changes require a reason and preserve retries', async () => {
  await render({ capabilities: { supervise: true, workActions: true } });
  await fill(container.querySelector('[aria-label="Action owner"]'), 'other');
  expect(button('Save action update').disabled).toBe(true);
  await fill(container.querySelector('[aria-label="Action update reason"]'), 'Available specialist will verify this change');
  api.patch.mockRejectedValue({ response: { data: { message: 'Concurrent update. Reload.' } } });
  await act(async () => button('Save action update').click());
  expect(onSaved).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Concurrent update');
  const requestId = api.patch.mock.calls[0][1].requestId;
  await act(async () => button('Save action update').click());
  expect(api.patch.mock.calls[1][1].requestId).toBe(requestId);
});
