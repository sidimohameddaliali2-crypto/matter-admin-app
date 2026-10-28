import { exclusionMatchesAny } from '../../client/src/constants/exclusionMatching/index.js';

const terms = value => Array.isArray(value) ? value.flatMap(item => terms(item?.name ?? item))
  : String(value || '').split(/[,;|\n\r]+/).map(item => item.trim()).filter(Boolean);

export const toKitchenOption = item => ({
  ...item, name: item.name || item.mealName, type: item.type || item.portionType,
  exclusions: terms(item.exclusions || item.intolerances),
});

export const mergeKitchenMetadata = (options, items) => options.map(option => {
  const item = items.find(candidate => String(candidate.mealName || '').trim().toLowerCase() === String(option.name || '').trim().toLowerCase());
  return item ? toKitchenOption({ ...item, ...option, exclusions: [...terms(item.intolerances), ...terms(option.exclusions)] }) : option;
});

export const kitchenMealConflicts = (option, exclusions = []) => {
  const components = {
    portion: [...terms(option.portionIngredients), ...terms(option.proteinSource), ...terms(option.portionType || option.type)],
    carb: [...terms(option.carbIngredients), ...terms(option.carbs)],
    veg: [...terms(option.vegIngredients), ...terms(option.veg)],
    sauce: [...terms(option.sauceIngredients), ...terms(option.sauce)],
    garnish: [...terms(option.garnishIngredients), ...terms(option.garnish)],
    general: [...terms(option.exclusions || option.intolerances), ...terms(option.allergens), ...terms(option.name || option.mealName), ...terms(option.ingredients)],
  };
  return Object.fromEntries(Object.entries(components).map(([component, ingredients]) => [component,
    exclusions.filter(exclusion => exclusionMatchesAny(exclusion, ingredients)),
  ]));
};

export const kitchenConflictList = (option, exclusions) => [...new Set(Object.values(kitchenMealConflicts(option, exclusions)).flat())];

export const kitchenConflictFields = (option, exclusions) => {
  const conflicts = kitchenMealConflicts(option, exclusions);
  const changes = ['carb', 'veg'].filter(component => conflicts[component].length);
  return {
    exclusionConflict: kitchenConflictList(option, exclusions),
    carbConflict: conflicts.carb, vegConflict: conflicts.veg,
    ...(changes.length ? { carbVegAction: 'replace', remark: changes.join('; ') } : {}),
    needsSauceChange: conflicts.sauce.length > 0, sauceConflict: conflicts.sauce,
    needsGarnishChange: conflicts.garnish.length > 0, garnishConflict: conflicts.garnish,
  };
};
