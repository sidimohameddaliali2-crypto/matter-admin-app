import { exclusionMatchesTerm, allergenMatchesAny } from '../exclusionMatching/index.js';

const terms = value => Array.isArray(value) ? value.flatMap(term => terms(term?.name ?? term)) : String(value ?? '').split(/[,;|\n\r]+/).map(term => term.trim()).filter(Boolean);
const unique = values => [...new Set(values)];
const matching = (values, exclusions) => unique(values.filter(value => exclusions.some(ex => exclusionMatchesTerm(ex, value))));

// Selection-only rules. Kitchen/auto-assignment deliberately keeps its own policy.
export function evaluateComponentSelection(item, exclusions = [], allergies = []) {
  const snapshot = item?.cycleMeal || {};
  const components = Array.isArray(snapshot.components) ? snapshot.components : [];
  const isSalad = snapshot.isSaladBase === true || components.some(c => c.type === 'Salad');
  const groups = { portion: [], carb: [], veg: [], salad: [], sauce: [], garnish: [], general: [] };
  const componentGroup = (component, visited = new Set()) => {
    if (!component || visited.has(component.id)) return 'sauce';
    if (['Protein', 'Portion', 'Breakfast', 'Snack'].includes(component.type)) return 'portion';
    if (component.type === 'Carb') return 'carb';
    if (component.type === 'Vegetable') return isSalad ? 'salad' : 'veg';
    if (component.type === 'Salad') return 'salad';
    if (component.type === 'Sauce 2') return isSalad ? 'salad' : 'sauce';
    if (component.type === 'Garnish') return 'garnish';
    if (component.type === 'Extra sauce / topping' && component.attachedComponentId) {
      const target = components.find(c => c.id === component.attachedComponentId);
      return componentGroup(target, new Set([...visited, component.id]));
    }
    return 'sauce';
  };
  components.forEach(component => groups[componentGroup(component)].push(...terms(component.name), ...terms(component.exclusions), ...terms(component.allergens), ...terms(component.ingredients)));
  const add = (group, ...values) => groups[group].push(...values.flatMap(terms));
  add('portion', item?.proteinSource, item?.portionIngredients);
  // Protein type is authoritative even when the recipe name is generic.
  for (const type of [item?.portionType, snapshot.mealType]) {
    if (['chicken', 'beef', 'fish'].includes(String(type || '').trim().toLowerCase())) add('portion', type);
  }
  add('carb', item?.carbs, item?.carbIngredients);
  add(isSalad ? 'salad' : 'veg', item?.veg, item?.vegIngredients);
  add('sauce', item?.sauce, item?.sauceIngredients);
  add('garnish', item?.garnish, item?.garnishIngredients);
  add('general', item?.intolerances, item?.ingredients);
  const ex = terms(exclusions);
  const matched = Object.fromEntries(Object.entries(groups).map(([group, values]) => [group, matching(values, ex)]));
  const allTerms = [...Object.values(groups).flat(), ...terms(item?.allergens)];
  const allergyMatches = terms(allergies).filter(allergy => allergenMatchesAny(allergy, allTerms));
  const combined = snapshot.carbCombined === true || String(snapshot.carbCombined || '').trim().toLowerCase() === 'yes';
  const classifiedTerms = Object.entries(groups).filter(([group]) => group !== 'general').flatMap(([, values]) => values);
  const generalOnly = ex.filter(exclusion => groups.general.some(value => exclusionMatchesTerm(exclusion, value)) && !classifiedTerms.some(value => exclusionMatchesTerm(exclusion, value)));
  const wholeMeal = !!(matched.portion.length || generalOnly.length || combined && (matched.carb.length || matched.veg.length || matched.salad.length));
  const vegConflict = unique([...matched.veg, ...matched.salad]);
  const carbVegConflict = unique([...matched.carb, ...vegConflict]);
  const publicTerms = [...groups.portion, ...groups.carb, ...groups.veg];
  return {
    allergies: unique(allergyMatches), wholeMeal,
    publicConflicts: unique([...ex.filter(exclusion => publicTerms.some(value => exclusionMatchesTerm(exclusion, value))), ...generalOnly]),
    matchedCarb: matched.carb, matchedVeg: matched.veg, hiddenVegConflict: matched.salad,
    flags: {
      ...(carbVegConflict.length ? { carbVegAction: 'replace' } : {}),
      carbVegConflict, carbConflict: matched.carb, vegConflict,
      needsSauceChange: matched.sauce.length > 0, needsGarnishChange: matched.garnish.length > 0,
      sauceConflict: matched.sauce, garnishConflict: matched.garnish,
    },
  };
}


// A customer preference is independent of the kitchen action: keeping a public
// carb/veg does not cancel the private replacement of salad or its dressing.
export function selectionPreferenceFlags(result, preference) {
  if (preference !== undefined && !['kept', 'replace'].includes(preference)) {
    throw Object.assign(new Error('Could not save your selections.'), { statusCode: 409 });
  }
  const flags = { ...result.flags };
  let preferenceConflict = [];
  if (result.wholeMeal) {
    delete flags.carbVegAction;
    if (flags.carbVegConflict.length) flags.carbVegAction = 'kept';
    preferenceConflict = unique([...result.publicConflicts, ...flags.carbVegConflict]);
    flags.carbConflict = [];
    flags.vegConflict = [];
    flags.carbVegConflict = [];
  } else if (preference === 'kept') {
    const hidden = unique(result.hiddenVegConflict || []);
    preferenceConflict = [...result.publicConflicts];
    if (hidden.length) {
      flags.carbVegAction = 'replace';
      flags.carbConflict = [];
      flags.vegConflict = hidden;
      flags.carbVegConflict = hidden;
    } else {
      if (flags.carbVegConflict.length) flags.carbVegAction = 'kept';
      flags.carbConflict = [];
      flags.vegConflict = [];
      flags.carbVegConflict = [];
    }
  }
  return { ...flags, preferenceConflict, exclusionConflict: [], ...(preference !== undefined ? { carbVegPreference: preference } : {}) };
}
