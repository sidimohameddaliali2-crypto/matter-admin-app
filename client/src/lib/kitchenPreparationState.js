const fetchPreparedKitchenState = async (api, menuId, date, isCurrent, { refresh, verifyAllergies }) => {
  const path = `/menus/${menuId}/kitchen-state`;
  const params = { date, ...(verifyAllergies && { verifyAllergies: true }) };
  let response;
  try { response = await api.get(path, { params, timeout: 180000 }); }
  catch (error) { if (error.response?.status === 404) return null; throw error; }
  if (!response?.data?.state) return null;
  let state = response.data;
  const deadline = Date.now() + 300000;
  if (state.state === 'missing' || (refresh && ['ready', 'allergy-review'].includes(state.state))) {
    state = (await api.post(path, { date, ...(refresh ? { refresh: true } : {}) }, { timeout: 30000 })).data;
    // Another request may finish between the initial GET and the POST.
    if (verifyAllergies && state.state === 'ready') {
      state = (await api.get(path, { params: { ...params, job: state.data?.snapshotId }, timeout: 180000 })).data;
    }
  }
  while (isCurrent()) {
    if (['ready', 'selection-open', 'allergy-review'].includes(state.state)) return state.data;
    if (['failed', 'stale'].includes(state.state) || state.success === false) throw new Error(state.message || 'Kitchen preparation failed. Retry the selected date.');
    if (state.state !== 'running' || !state.jobId || Date.now() >= deadline) throw new Error('Kitchen preparation timed out. Retry the selected date.');
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!isCurrent()) break;
    state = (await api.get(path, { params: { ...params, job: state.jobId }, timeout: verifyAllergies ? 180000 : 30000 })).data;
  }
  throw new Error('Kitchen selection changed during preparation.');
};

// Share only in-flight work. Every later load still asks the server to verify
// its source version/freshness; no new persistent roster cache is introduced.
const inFlight = new WeakMap();
export const loadPreparedKitchenState = async (api, menuId, date, isCurrent, { refresh = false, verifyAllergies = false } = {}) => {
  if (!isCurrent()) throw new Error('Kitchen selection changed during preparation.');
  let requests = inFlight.get(api);
  if (!requests) { requests = new Map(); inFlight.set(api, requests); }
  // A forced refresh cannot join a normal read that may return the previous
  // ready version. Concurrent forced refreshes can still share their work.
  const key = `${menuId}:${date}:${refresh}:${verifyAllergies}`;
  let shared = requests.get(key);
  if (!shared) {
    shared = { consumers: new Set() };
    requests.set(key, shared);
  }
  const consumer = { isCurrent };
  shared.consumers.add(consumer);
  if (!shared.promise) shared.promise = fetchPreparedKitchenState(api, menuId, date,
    () => [...shared.consumers].some(item => item.isCurrent()), { refresh, verifyAllergies })
    .finally(() => { if (requests.get(key) === shared) requests.delete(key); });
  try {
    const result = await shared.promise;
    if (!isCurrent()) throw new Error('Kitchen selection changed during preparation.');
    return result;
  } finally { shared.consumers.delete(consumer); }
};
