import { loadPreparedKitchenState } from './kitchenPreparationState';

test('all views reuse the same ready version without starting a new assignment', async () => {
  const payload = { snapshotId: 'immutable-version', preparation: 'completed', data: { kitchenSelections: [] } };
  const api = { get: jest.fn().mockResolvedValue({ data: { success: true, state: 'ready', data: payload } }), post: jest.fn() };
  expect(await loadPreparedKitchenState(api, 'menu', '2026-10-30', () => true)).toBe(payload);
  expect(api.post).not.toHaveBeenCalled();
});

test('a failed background preparation is surfaced instead of exporting empty selections', async () => {
  const api = { get: jest.fn().mockResolvedValue({ data: { success: true, state: 'failed', message: 'Missing breakfast preset' } }) };
  await expect(loadPreparedKitchenState(api, 'menu', '2026-10-30', () => true)).rejects.toThrow('Missing breakfast preset');
});

test('cancelled dates do not publish a pending job result', async () => {
  const api = { get: jest.fn().mockResolvedValue({ data: { success: true, state: 'running', jobId: 'job' } }) };
  await expect(loadPreparedKitchenState(api, 'menu', '2026-10-30', () => false)).rejects.toThrow('selection changed');
});
