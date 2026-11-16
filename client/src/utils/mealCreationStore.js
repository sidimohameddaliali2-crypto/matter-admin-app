import api from './api';
const legacyBoardShape = days => Array.isArray(days) && days.length === 7 && days.every(groups => Array.isArray(groups) && groups.length === 4 && groups.every(entries => Array.isArray(entries) && entries.every(entry => entry && typeof entry.mealId === 'string')));

export const readLegacyMealDraft = () => {
  try {
    const read = key => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
    let catalogue = read('matter-admin-v2:workbook-cycle-v2');
    const obsoleteSamples = new Set();
    if (!Array.isArray(catalogue?.meals)) {
      catalogue = read('matter-admin-v2:workbook-cycle-v1');
      // The v1 April seed was bundled demo data. Custom meals added alongside
      // it survive; real later imports (including v2 April files) are retained.
      if (catalogue?.source === 'April_Cycle_1_Meals_and_Exclusions.xlsx' && Array.isArray(catalogue.meals)) {
        catalogue.meals.forEach(meal => { if (/^APR1-/.test(meal?.id)) obsoleteSamples.add(meal.id); });
        catalogue = { ...catalogue, meals: catalogue.meals.filter(meal => !obsoleteSamples.has(meal?.id)), source: '' };
      }
    }
    if (!Array.isArray(catalogue?.meals) || !catalogue.meals.length) return undefined;
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('matter-admin-v2:weekly-board-v1') || '{}') || {}; }
    catch { saved = {}; }
    const boards = {};
    for (const [key, days] of Object.entries(saved)) if (key.startsWith('Main menu:')) {
      if (!legacyBoardShape(days)) continue;
      try { boards[key] = days.map(groups => groups.map(entries => entries.filter(entry => !obsoleteSamples.has(entry.mealId)).map(({ mealId, isMatterCore }) => ({ mealId, isMatterCore: !!isMatterCore })))); }
      catch { /* A damaged board must not prevent migration of valid meals. */ }
    }
    for (const [key, days] of Object.entries(saved)) if (key.startsWith('Matter Core menu:')) {
      if (!legacyBoardShape(days)) continue;
      const target = key.replace('Matter Core menu:', 'Main menu:');
      boards[target] ||= Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
      days.forEach((groups, day) => groups.forEach((entries, slot) => entries.forEach(({ mealId }) => {
        if (obsoleteSamples.has(mealId)) return;
        const existing = boards[target][day][slot].find(entry => entry.mealId === mealId);
        if (existing) existing.isMatterCore = true;
        else boards[target][day][slot].push({ mealId, isMatterCore: true });
      })));
    }
    return { catalogue, boards };
  } catch { return undefined; }
};

export function createMealCreationStore(client, legacyReader = () => undefined) {
  let snapshot = { status: 'idle', data: null, error: '', saving: false };
  let queue = Promise.resolve();
  const listeners = new Set();
  const publish = change => { snapshot = { ...snapshot, ...change }; listeners.forEach(listener => listener()); };
  const enqueue = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  const accept = response => {
    if (!response.data?.success || !Array.isArray(response.data.data?.catalogue?.meals) || !response.data.data?.boards || !Number.isInteger(response.data.data.revision)) throw new Error(response.data?.message || 'The saved meal library could not be read.');
    publish({ status: 'ready', data: response.data.data, error: '', saving: false });
    return response.data.data;
  };
  const reject = error => {
    publish({ status: snapshot.data ? 'ready' : 'error', saving: false, error: error.response?.data?.message || error.message || 'Meals could not be saved. Please reload before editing.' });
    throw error;
  };
  return {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    flush: () => queue,
    load: () => enqueue(async () => {
      publish({ status: 'loading', error: '' });
      try { return accept(await client.post('/meal-creation/bootstrap', { legacy: legacyReader() })); }
      catch (error) { return reject(error); }
    }),
    save: change => enqueue(async () => {
      if (!snapshot.data || snapshot.error) throw new Error(snapshot.error || 'Load the saved library before editing.');
      publish({ saving: true });
      try { return accept(await client.put('/meal-creation', { ...change, revision: snapshot.data.revision })); }
      catch (error) { return reject(error); }
    }),
  };
}

export const mealCreationStore = createMealCreationStore(api, readLegacyMealDraft);
