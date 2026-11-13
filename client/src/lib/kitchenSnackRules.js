import { snackCatalogue, snackRuleConflict } from '../constants/kitchenSnackPolicy';

export const fetchKitchenSnackRules = async (api, included) => {
  if (Array.isArray(included)) return included;
  const response = await api.get('/menus/kitchen-snack-rules', { timeout: 30000 });
  if (response.data?.success !== true || !Array.isArray(response.data?.data?.rules)) throw new Error('Snack rules could not be verified. Retry preparation.');
  return response.data.data.rules;
};

// Run after enrichment so legacy rows use the verified permanent customer ID.
export const applyKitchenSnackRules = (selections, rules, presets) => {
  const byId = new Map((rules || []).map(rule => [String(rule.customerId), rule]));
  const catalogue = snackCatalogue(presets);
  return selections.map(entry => {
    const rule = byId.get(String(entry.matterCustomerId));
    return { ...entry, snackRule: { blockedSnacks: rule?.blockedSnacks || [], version: rule?.version || 0 },
      selectedMeals: (entry.selectedMeals || []).map(meal => ({ ...meal,
        snackRuleConflict: snackRuleConflict(meal, rule, catalogue) ? `Blocked snack: ${meal.mealName}. Review and replace this auto-assigned snack.` : null,
      })),
    };
  });
};
