export const loadPreparedKitchenState = async (api, menuId, date, isCurrent) => {
  const path = `/menus/${menuId}/kitchen-state`;
  let response;
  try { response = await api.get(path, { params: { date }, timeout: 30000 }); }
  catch (error) { if (error.response?.status === 404) return null; throw error; }
  if (!response?.data?.state) return null;
  let state = response.data;
  const deadline = Date.now() + 300000;
  if (state.state === 'missing') state = (await api.post(path, { date }, { timeout: 30000 })).data;
  while (isCurrent()) {
    if (state.state === 'ready') return state.data;
    if (['failed', 'stale'].includes(state.state) || state.success === false) throw new Error(state.message || 'Kitchen preparation failed. Retry the selected date.');
    if (state.state !== 'running' || !state.jobId || Date.now() >= deadline) throw new Error('Kitchen preparation timed out. Retry the selected date.');
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!isCurrent()) break;
    state = (await api.get(path, { params: { date, job: state.jobId }, timeout: 30000 })).data;
  }
  throw new Error('Kitchen selection changed during preparation.');
};
