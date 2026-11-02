import { loadPreparedKitchenState } from './kitchenPreparationState';

test('open selection returns existing choices without starting assignment or a preparation job', async () => {
  const payload = { preparation: 'selection-open', selectionWindow: { canAutoAssign: false }, data: { kitchenSelections: [{ selectedMeals: [{ mealName: 'Customer choice' }] }] } };
  const api = { get: jest.fn().mockResolvedValue({ data: { state: 'selection-open', data: payload } }), post: jest.fn() };
  expect(await loadPreparedKitchenState(api, 'menu', '2099-11-02', () => true)).toBe(payload);
  expect(api.post).not.toHaveBeenCalled();
});

test('all views reuse the same ready version without starting a new assignment', async () => {
  const payload = { snapshotId: 'immutable-version', preparation: 'completed', data: { kitchenSelections: [] } };
  const api = { get: jest.fn().mockResolvedValue({ data: { success: true, state: 'ready', data: payload } }), post: jest.fn() };
  expect(await loadPreparedKitchenState(api, 'menu', '2026-10-30', () => true)).toBe(payload);
  expect(api.post).not.toHaveBeenCalled();
});

test('explicit Refresh bypasses a ready snapshot and returns freshly prepared data', async () => {
  const payload = { preparation: 'completed', data: { kitchenSelections: [] } };
  const api = { get: jest.fn().mockResolvedValue({ data: { state: 'ready', data: { obsolete: true } } }),
    post: jest.fn().mockResolvedValue({ data: { state: 'ready', data: payload } }) };
  expect(await loadPreparedKitchenState(api, 'menu', '2026-10-30', () => true, { refresh: true })).toBe(payload);
  expect(api.post).toHaveBeenCalledWith('/menus/menu/kitchen-state', { date: '2026-10-30', refresh: true }, { timeout: 30000 });
});

test('Refresh on an open date stays read-only and never starts preparation', async () => {
  const payload = { preparation: 'selection-open', data: { kitchenSelections: [] } };
  const api = { get: jest.fn().mockResolvedValue({ data: { state: 'selection-open', data: payload } }), post: jest.fn() };
  expect(await loadPreparedKitchenState(api, 'menu', '2099-11-02', () => true, { refresh: true })).toBe(payload);
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
