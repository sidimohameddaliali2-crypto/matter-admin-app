export const EXCLUSION_GROUPS = {
  'all nuts': ['nut', 'nuts', 'peanut', 'peanuts', 'walnut', 'cashew', 'pistachio', 'almond', 'pine nuts', 'hazelnut', 'pecan', 'macadamia'],
  'all fish': ['fish', 'cream dory', 'nile perch', 'shrimp', 'salmon', 'squid', 'tuna', 'scallop', 'cod', 'sea bass', 'sea bream'],
  'all sea food': ['seafood', 'sea food', 'fish', 'cream dory', 'nile perch', 'salmon', 'tuna', 'cod', 'sea bass', 'sea bream', 'shrimp', 'prawn', 'crab', 'lobster', 'mussel', 'scallop', 'squid', 'calamari'],
};

const escapeRegexChars = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word/whole-phrase substring check — `\b` either side, so "Potato"
// matches inside "Sweet Potato Mash" but "Egg" does NOT match inside
// "Eggplant" (no word boundary right after "Egg" there) and "Pea" does not
// match inside "Peanut" for the same reason.
const containsWholePhrase = (haystack, needle) => {
  if (!haystack || !needle) return false;
  return new RegExp(`\\b${escapeRegexChars(needle)}\\b`, 'i').test(haystack);
};

// Normalize simple plurals without broad substring matching (Egg must never
// match Eggplant, and Pea must never match Peanut).
const normalizeTerm = (value) => String(value || '').trim().toLowerCase()
  .replace(/\b(eggs|almonds|peanuts|cashews|walnuts|pistachios|hazelnuts|pecans|prawns|mussels|scallops)\b/g, (word) => word.slice(0, -1));

const matchesTerm = (ex, t) => {
  if (!ex || !t) return false;
  if (ex === t) return true;
  const group = EXCLUSION_GROUPS[ex] || (ex === 'nuts' ? EXCLUSION_GROUPS['all nuts'] : null);
  if (group && group.some((member) => containsWholePhrase(t, member))) return true;
  return containsWholePhrase(t, ex) || containsWholePhrase(ex, t);
};

/**
 * True if `term` (a meal ingredient name) should be treated as excluded by
 * `exclusionPhrase` (one of the customer's canonical exclusion phrases).
 * Owner (2026-10-13): a real conflict was sometimes missed when the
 * ingredient name was more specific than the customer's plain exclusion
 * phrase — e.g. exclusion "Potato" against a carb named "Sweet Potato Mash"
 * used to require an exact string match and silently passed. Matches now on:
 * an exact match, `term` belonging to an umbrella group (EXCLUSION_GROUPS,
 * e.g. "All Nuts"), or either string containing the other as a whole
 * word/phrase (so "Potato" <-> "Sweet Potato Mash" matches both ways, while
 * "Egg" / "Eggplant" and "Pea" / "Peanut" correctly do not).
 */
export const exclusionMatchesTerm = (exclusionPhrase, term) => {
  const raw = normalizeTerm(exclusionPhrase);
  const ex = ({ 'dairy-free': 'dairy', 'dairy free': 'dairy', 'gluten-free': 'gluten', 'gluten free': 'gluten', 'egg-free': 'egg', 'egg free': 'egg', 'all seafood': 'all sea food' })[raw] || raw;
  const t = normalizeTerm(term);
  // Owner: Raw Onion excludes only explicitly raw onion, not generic/cooked onion.
  // Keep this dietary rule separate from the more conservative allergy matcher.
  if (ex === 'raw onion') return containsWholePhrase(t, ex);
  // A dietary preference should not warn on the explicit ingredient label
  // "Gluten Free Flour" solely because the word "Gluten" occurs in it.
  if (['gluten', 'dairy', 'milk', 'egg'].includes(ex)
      && new RegExp(`\\b${escapeRegexChars(ex)}[ -]+free\\b`, 'i').test(t)) return false;
  return matchesTerm(ex, t);
};

// Known catalogue ingredients can have their own interpretation. A generic
// "free" claim must never override a separate declared allergen.
const DAIRY_ALLERGEN_TERMS = ['milk', 'dairy', 'butter', 'buttermilk', 'ghee', 'whey', 'casein', 'cheese', 'yogurt', 'yoghurt',
  'cream', 'labneh', 'custard', 'creme fraiche', 'crème fraîche', 'paneer', 'halloumi', 'mozzarella', 'ricotta',
  'feta', 'parmesan', 'cheddar', 'mascarpone', 'kefir'];
const NUT_ALLERGEN_TERMS = [...EXCLUSION_GROUPS['all nuts'], 'brazil nut', 'brazil nuts', 'macadamia nuts'];
const TREE_NUT_ALLERGEN_TERMS = NUT_ALLERGEN_TERMS.filter(name => !/^(?:peanut|nut)s?$/.test(name));
const CRUSTACEAN_ALLERGEN_TERMS = ['crustacean', 'crustaceans', 'shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'crayfish', 'langoustine'];
const MOLLUSC_ALLERGEN_TERMS = ['mollusc', 'mollusk', 'shellfish', 'seafood', 'sea food', 'mussel', 'scallop',
  'clam', 'oyster', 'cockle', 'whelk', 'abalone', 'squid', 'calamari', 'octopus', 'cuttlefish'];
const WHEAT_ALLERGEN_TERMS = ['wheat', 'spelt', 'durum', 'semolina', 'bulgur', 'couscous', 'seitan', 'farro', 'einkorn', 'emmer', 'kamut'];
const ALLERGEN_PROFILE_ALIASES = {
  soya: 'soy',
  soybean: 'soy',
  soybeans: 'soy',
  'tree nut': 'tree nuts',
  crustacean: 'crustaceans',
  mollusk: 'mollusc',
  'sesame seed': 'sesame',
  'sesame seeds': 'sesame',
  'cereals containing gluten': 'gluten',
};
const normalizeAllergenTerm = value => normalizeTerm(value)
  .replace(/\b(?:ground[ -]?nuts?|arachis)\b/g, 'peanut')
  .replace(/\b(?:metabisulphites?|metabisulfites?|bisulphites?|bisulfites?|sulphites?|sulfites?)\b/g, 'sulfite')
  .replace(/\b(shrimps|crabs|lobsters|langoustines|macadamias|clams|oysters|cockles|whelks|sardines|squids|molluscs|mollusks)\b/g, word => word.slice(0, -1))
  .replace(/\b(crayfishes|cuttlefishes)\b/g, word => word.slice(0, -2))
  .replace(/\banchovies\b/g, 'anchovy');
const ALLERGEN_GROUPS = {
  milk: DAIRY_ALLERGEN_TERMS,
  dairy: DAIRY_ALLERGEN_TERMS,
  nuts: NUT_ALLERGEN_TERMS,
  'all nuts': NUT_ALLERGEN_TERMS,
  'tree nuts': TREE_NUT_ALLERGEN_TERMS,
  soy: ['soy', 'soya', 'soybean', 'soybeans', 'soya bean', 'soya beans', 'edamame', 'tofu', 'bean curd', 'beancurd', 'miso', 'tempeh', 'tamari'],
  egg: ['egg', 'mayonnaise', 'mayo', 'aioli', 'meringue', 'ovalbumin'],
  sesame: ['sesame', 'tahini', 'tahina', 'tahine', 'zaatar', 'za\'atar'],
  mustard: ['mustard', 'dijon'],
  wheat: WHEAT_ALLERGEN_TERMS,
  gluten: ['gluten', ...WHEAT_ALLERGEN_TERMS, 'barley', 'rye', 'oat', 'oats', 'khorasan', 'triticale', 'pasta', 'bread'],
  fish: ['fish', 'seafood', 'sea food', 'cream dory', 'nile perch', 'salmon', 'tuna', 'cod', 'sea bass', 'sea bream',
    'anchovy', 'sardine', 'herring', 'mackerel', 'trout', 'tilapia', 'haddock', 'pollock', 'halibut', 'snapper', 'grouper', 'barramundi', 'mahi mahi'],
  shellfish: [...CRUSTACEAN_ALLERGEN_TERMS, ...MOLLUSC_ALLERGEN_TERMS],
  crustaceans: CRUSTACEAN_ALLERGEN_TERMS,
  mollusc: MOLLUSC_ALLERGEN_TERMS,
};
export const allergenMatchesAny = (allergy, terms) => {
  const normalized = normalizeAllergenTerm(allergy);
  const key = ALLERGEN_PROFILE_ALIASES[normalized] || normalized;
  const names = ALLERGEN_GROUPS[key] || [key];
  const specificNut = NUT_ALLERGEN_TERMS.some(name => normalizeTerm(name) === key);
  return (terms || []).some(term => {
    const ingredient = normalizeAllergenTerm(term);
    if (key === 'gluten' && /^gluten[ -]free flour$/.test(ingredient)) return false;
    const declared = ingredient.replace(/^contains\s+/, '');
    if (key === 'tree nuts' && /\bnuts?\b/.test(declared)) return true;
    if (specificNut && ['nut', 'nuts', 'all nuts'].includes(declared)) return true;
    if (specificNut && key !== 'peanut' && ['tree nut', 'tree nuts'].includes(declared)) return true;
    const candidate = names === DAIRY_ALLERGEN_TERMS
      ? ingredient.replace(/\b(?:peanut|almond|cashew|pistachio|hazelnut|cocoa|cacao|coconut|seed|oat|soy|soya|rice) (?:butter|milk|cream)\b|\b(?:cream dory|butter beans?)\b/g, '')
      : ingredient;
    return names.some(name => matchesTerm(name, candidate));
  });
};

/** True if `exclusionPhrase` matches any term in `terms` — see exclusionMatchesTerm. */
export const exclusionMatchesAny = (exclusionPhrase, terms) =>
  (terms || []).some((t) => exclusionMatchesTerm(exclusionPhrase, t));
