import { loadPreparedKitchenState } from './kitchenPreparationState';

test('Refresh stays fresh during an in-flight normal read, while simultaneous refreshes share one request', async () => {
  let releaseNormal, releaseRefresh;
  let notifyPost;
  const postStarted = new Promise(resolve => { notifyPost = resolve; });
  const old = { snapshotId: 'old', data: { kitchenSelections: [] } };
  const fresh = { snapshotId: 'fresh', data: { kitchenSelections: [{ mealName: 'Saved choice', quantity: 2, remark: 'veg' }] } };
  const api = {
    get: jest.fn().mockImplementationOnce(() => new Promise(resolve => { releaseNormal = resolve; }))
      .mockResolvedValue({ data: { state: 'ready', data: old } }),
    post: jest.fn(() => { notifyPost(); return new Promise(resolve => { releaseRefresh = resolve; }); }),
  };
  const normal = loadPreparedKitchenState(api, 'menu', '2026-11-06', () => true);
  const refreshA = loadPreparedKitchenState(api, 'menu', '2026-11-06', () => true, { refresh: true });
  const refreshB = loadPreparedKitchenState(api, 'menu', '2026-11-06', () => true, { refresh: true });
  await postStarted;
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/menus/menu/kitchen-state', { date: '2026-11-06', refresh: true }, { timeout: 30000 });
  releaseRefresh({ data: { state: 'ready', data: fresh } });
  expect(await refreshA).toBe(fresh); expect(await refreshB).toBe(fresh);
  releaseNormal({ data: { state: 'ready', data: old } });
  expect(await normal).toBe(old);
});

test('simultaneous List/Counting loads share one read, cancelled consumers cannot discard another view, later reads verify again', async () => {
  let release, active = true;
  const payload={snapshotId:'same-version',data:{kitchenSelections:[{selectedMeals:[{mealName:'Chosen meal',quantity:2,remark:'veg'}]}]}};
  const api={get:jest.fn(()=>new Promise(resolve=>{release=resolve;})),post:jest.fn()};
  const first=loadPreparedKitchenState(api,'menu','2026-11-06',()=>active);
  const rejected=expect(first).rejects.toThrow('selection changed');
  const second=loadPreparedKitchenState(api,'menu','2026-11-06',()=>true);
  active=false;release({data:{state:'ready',data:payload}});
  await rejected;expect(await second).toBe(payload);expect(api.get).toHaveBeenCalledTimes(1);
  api.get.mockResolvedValueOnce({data:{state:'ready',data:payload}});
  expect(await loadPreparedKitchenState(api,'menu','2026-11-06',()=>true)).toBe(payload);
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.post).not.toHaveBeenCalled();
});

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
