import { exclusionMatchesAny } from '../../client/src/constants/exclusionMatching/index.js';
import { mealFingerprint } from './mealLibraryDuplicates.js';

const terms = value => Array.isArray(value) ? value.flatMap(item => terms(item?.name ?? item))
  : String(value || '').split(/[,;|\n\r]+/).map(item => item.trim()).filter(Boolean);
const nameKey = value => String(value || '').trim().toLowerCase();
const compactName = value => nameKey(value).replace(/\s+/g, ' ');
const normalizedTerms = value => [...new Set(terms(value).map(compactName))].sort();
export const datedKitchenProtein = item => [item.portionType, item.cycleMeal?.mealType].map(nameKey)
  .find(protein => ['chicken', 'beef', 'fish'].includes(protein));

const ingredientsForIdentity = value => Array.isArray(value) ? value.map(ingredient => {
  if (!ingredient || typeof ingredient !== 'object') return ingredient;
  const { visible, ...stored } = ingredient;
  return stored;
}) : value;

export const datedKitchenRecipeKeys = item => {
  const recipe = item.cycleMeal;
  const components = Array.isArray(recipe?.components) && recipe.components.every(component => component && typeof component === 'object')
    ? recipe.components : [];
  const legacyLabels = { proteinSource: ['Protein', 'Portion'], carbs: ['Carb'], veg: ['Vegetable', 'Salad'],
    sauce: ['Sauce'], garnish: ['Garnish'] };
  const fields = [...Object.keys(legacyLabels), 'ingredients', 'portionIngredients', 'carbIngredients',
    'vegIngredients', 'sauceIngredients', 'garnishIngredients'];
  const legacyTerms = field => {
    const labels = components.filter(component => legacyLabels[field]?.includes(component.type)).map(component => compactName(component.name));
    if (field === 'proteinSource' && components.length) labels.push(datedKitchenProtein(item));
    return terms(item[field]).map(compactName).filter(term => !labels.includes(term)).sort();
  };
  const preparation = fields.map(legacyTerms);
  const legacySnapshot = ['ingredients', 'exclusions', 'allergens'].map(field => normalizedTerms(recipe?.[field]));
  const labelIdentity = [compactName(item.mealName), datedKitchenProtein(item)];
  if (!components.length && ![...legacySnapshot, ...preparation].some(values => values.length)) {
    // A name-only historical copy may still carry a saved rotation warning.
    // Use the name for those warnings, without assuming duplicate portions.
    return { assignmentCopyKey: JSON.stringify(['legacy', ...labelIdentity]) };
  }
  const snapshot = components.length ? mealFingerprint({ ...recipe, ingredients: ingredientsForIdentity(recipe.ingredients),
    components: components.map(component => ({ ...component, ingredients: ingredientsForIdentity(component.ingredients) })) },
  { ignoreQuantity: true }) : legacySnapshot;
  const snapshotIdentity = [...labelIdentity, snapshot];
  const assignmentRecipeKey = JSON.stringify([...snapshotIdentity, ...preparation]);
  const comparablePreparation = preparation.filter((_, index) => fields[index] !== 'ingredients');
  return { assignmentRecipeKey,
    assignmentCopyKey: components.length ? JSON.stringify([...snapshotIdentity.slice(1), ...comparablePreparation]) : assignmentRecipeKey };
};

export const datedKitchenRestrictionKey = item => JSON.stringify(['intolerances', 'exclusions', 'allergens']
  .map(field => normalizedTerms(item[field])));

export const datedKitchenIngredientKey = item => {
  const ingredients = normalizedTerms(item.ingredients);
  return ingredients.length ? JSON.stringify(ingredients) : null;
};

export const toKitchenOption = item => ({
  ...item, name: item.name || item.mealName, type: item.type || item.portionType,
  exclusions: [...new Set([...terms(item.exclusions), ...terms(item.intolerances)])],
});

const mergeKitchenOption = (option, item) => toKitchenOption({ ...item, ...option,
  cycleMeal: item.cycleMeal || option.cycleMeal,
  exclusions: [...terms(item.exclusions), ...terms(option.exclusions)],
});

export const mergeKitchenMetadata = (options, items) => options.map(option => {
  const item = items.find(candidate => nameKey(candidate.mealName) === nameKey(option.name));
  return item ? mergeKitchenOption(option, item) : option;
});

// Older rotations store only names and tags. Use the real dated recipes for
// exclusion checks and keep their IDs so the kitchen sees the chosen variant.
export const hydrateMainRotation = (options, items, rotation = options, role) => options.flatMap(option => {
  const competingType = rotation.some(entry => entry.type !== option.type
    && compactName(entry.name) === compactName(option.name));
  const compatible = items.filter(item => {
    const protein = datedKitchenProtein(item);
    return protein ? protein === option.type : !competingType;
  });
  const named = compatible.filter(item => nameKey(item.mealName) === nameKey(option.name));
  const similar = compatible.filter(item => compactName(item.mealName) === compactName(option.name));
  // An imprecise historical name must not borrow a recipe explicitly listed
  // under its exact name elsewhere in the rotation.
  const unclaimed = similar.filter(item => !rotation.some(entry => entry.type === option.type
    && nameKey(entry.name) === nameKey(item.mealName)
    && (!role || item.rotationCategory !== role || options.includes(entry))));
  const roleCompatible = role ? unclaimed.filter(item => !item.rotationCategory || item.rotationCategory === role) : [];
  const namedForRole = role ? named.filter(item => !item.rotationCategory || item.rotationCategory === role) : [];
  let matches = [namedForRole, named, roleCompatible, unclaimed].find(group => group.length) || [];
  const opposite = rotation.filter(entry => !options.includes(entry) && entry.type === option.type
    && compactName(entry.name) === compactName(option.name));
  if (role && opposite.length) {
    // A tagged recipe belongs to the matching pool unless that pool already
    // has a different, exact dated match for each of its similar names.
    const candidates = [...named, ...unclaimed];
    const tagged = candidates.filter(item => item.rotationCategory === role);
    const untagged = candidates.filter(item => !item.rotationCategory);
    const freeForRole = candidates.filter(item => opposite.every(entry => nameKey(entry.name) !== nameKey(item.mealName)
      && similar.some(candidate => nameKey(candidate.mealName) === nameKey(entry.name))));
    const exactTagged = named.filter(item => item.rotationCategory === role);
    const exactUntagged = named.filter(item => !item.rotationCategory);
    matches = [exactTagged, exactUntagged, tagged, untagged, freeForRole].find(group => group.length) || [];
  }
  return matches.length ? matches.map(item => mergeKitchenOption({ ...option, name: item.mealName, rotationName: option.name,
    rotationExclusions: terms(option.exclusions) }, item)) : [option];
});

export const kitchenMealConflicts = (option, exclusions = []) => {
  const snapshot = option.cycleMeal || {};
  const main = option.mealType === 'main' || !option.mealType && ['chicken', 'beef', 'fish'].includes(option.type);
  const components = {
    portion: [...terms(option.portionIngredients), ...terms(option.proteinSource), ...terms(option.portionType || option.type),
      ...terms(main && /^(chicken|beef|fish)$/i.test(snapshot.mealType || '') ? snapshot.mealType : '')],
    carb: [...terms(option.carbIngredients), ...terms(option.carbs)],
    veg: [...terms(option.vegIngredients), ...terms(option.veg)],
    sauce: [...terms(option.sauceIngredients), ...terms(option.sauce)],
    garnish: [...terms(option.garnishIngredients), ...terms(option.garnish)],
    general: [...terms(option.exclusions), ...terms(option.intolerances), ...terms(option.allergens), ...terms(option.name), ...terms(option.mealName), ...terms(option.rotationName),
      ...terms(option.ingredients), ...(main ? [snapshot.exclusions, snapshot.allergens, snapshot.ingredients].flatMap(terms) : [])],
  };
  // Cycle imports store ingredient exclusions on components, not legacy fields.
  // Keep kitchen replacement flags scoped to the component that conflicts.
  const recipe = Array.isArray(snapshot.components) ? snapshot.components : [];
  const isSalad = snapshot.isSaladBase === true || recipe.some(component => component?.type === 'Salad')
    || (snapshot.isSaladBase !== false && terms(snapshot.tags).some(tag => /^salad\s+base$/i.test(tag)));
  const groupOf = (component, visited = new Set()) => {
    if (!component || visited.has(component)) return 'general';
    if (['Protein', 'Portion', 'Breakfast', 'Snack'].includes(component.type)) return 'portion';
    if (component.type === 'Carb') return 'carb';
    if (['Vegetable', 'Salad'].includes(component.type)) return 'veg';
    if (component.type === 'Garnish') return 'garnish';
    if (component.type === 'Sauce 2' && isSalad) return 'veg';
    if (component.type === 'Extra sauce / topping' && component.attachedComponentId) {
      return groupOf(recipe.find(candidate => candidate?.id === component.attachedComponentId), new Set([...visited, component]));
    }
    if (['Sauce', 'Sauce 2', 'Extra sauce / topping'].includes(component.type)) return 'sauce';
    return 'general';
  };
  for (const component of recipe) {
    if (!component) continue;
    components[groupOf(component)].push(...terms(component.name), ...terms(component.exclusions),
      ...terms(component.allergens), ...terms(component.ingredients));
  }
  return Object.fromEntries(Object.entries(components).map(([component, ingredients]) => {
    const names = main ? ingredients.map(compactName) : ingredients;
    return [component, exclusions.filter(exclusion => exclusionMatchesAny(main ? compactName(exclusion) : exclusion, names))];
  }));
};

export const kitchenConflictList = (option, exclusions) => [...new Set(Object.values(kitchenMealConflicts(option, exclusions)).flat())];

export const kitchenConflictFields = (option, exclusions) => {
  const conflicts = kitchenMealConflicts(option, exclusions);
  const changes = ['carb', 'veg'].filter(component => conflicts[component].length);
  return {
    exclusionConflict: [...new Set(Object.values(conflicts).flat())],
    carbConflict: conflicts.carb, vegConflict: conflicts.veg,
    ...(changes.length ? { carbVegAction: 'replace', remark: changes.join('; ') } : {}),
    needsSauceChange: conflicts.sauce.length > 0, sauceConflict: conflicts.sauce,
    needsGarnishChange: conflicts.garnish.length > 0, garnishConflict: conflicts.garnish,
  };
};
