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
  // A dietary preference should not warn on the explicit ingredient label
  // "Gluten Free Flour" solely because the word "Gluten" occurs in it.
  if (['gluten', 'dairy', 'milk', 'egg'].includes(ex)
      && new RegExp(`\\b${escapeRegexChars(ex)}[ -]+free\\b`, 'i').test(t)) return false;
  return matchesTerm(ex, t);
};

// Allergy checks deliberately do not waive a match based on a "free" claim.
// Declared allergen/ingredient metadata must still block a matching profile.
const ALLERGEN_GROUPS = {
  milk: ['milk', 'dairy'],
  dairy: ['dairy', 'milk'],
  nuts: EXCLUSION_GROUPS['all nuts'],
  'all nuts': EXCLUSION_GROUPS['all nuts'],
  fish: ['fish', 'cream dory', 'nile perch', 'salmon', 'tuna', 'cod', 'sea bass', 'sea bream'],
  shellfish: ['shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'mussel', 'scallop', 'squid', 'calamari'],
};
export const allergenMatchesAny = (allergy, terms) => {
  const key = normalizeTerm(allergy);
  const names = ALLERGEN_GROUPS[key] || [key];
  return (terms || []).some((term) => names.some((name) => matchesTerm(name, normalizeTerm(term))));
};

/** True if `exclusionPhrase` matches any term in `terms` — see exclusionMatchesTerm. */
export const exclusionMatchesAny = (exclusionPhrase, terms) =>
  (terms || []).some((t) => exclusionMatchesTerm(exclusionPhrase, t));
