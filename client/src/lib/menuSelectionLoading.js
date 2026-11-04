import { enrichSelectionsWithNutrition } from './kitchenData';

// Browsing saved choices is a read. Current Matter nutrition is needed only
// when opening the detail or exporting, never as a prerequisite for searching.
export const loadMenuSelectionSummaries = async (api, menuId) => {
  const response = await api.get(`/menus/${menuId}/selections`, { params: { includeNames: 'true' }, timeout: 30000 });
  if (!response.data?.success) throw new Error(response.data?.message || 'Failed to load selections');
  return response.data.data || [];
};

export const loadMenuSelectionDetails = (api, customers) => enrichSelectionsWithNutrition(
  api, customers, { current: new Map() }, { extended: true }
);
