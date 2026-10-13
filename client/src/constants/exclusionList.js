// Canonical exclusion phrase list — all items from the predefined list.
// Sorted longest-phrase-first so the greedy matching always picks the most specific phrase.
export const EXCLUSION_LIST = [
  'All Sea Food',
  'Gluten Free Flour',
  'Parmesan Cheese',
  'Tandoori Spice',
  'Tortilla bread',
  'Vegan sausage',
  'Almond Milk',
  'Baby Carrot',
  'Baby Marrow',
  'Bean Noodles',
  'Beef Curry',
  'Black Grapes',
  'Boiled Egg',
  'Brown Sugar',
  'Brussels Sprouts',
  'Cheddar Cheese',
  'Cherry Tomato',
  'Coconut Milk',
  'Cooking cream',
  'Corn Flour',
  'Cream Dory',
  'Cube Beef',
  'Dragon Fruit',
  'Egg Noodles',
  'Feta cheese',
  'Green Beans',
  'Green Peas',
  'Kenya Beans',
  'Lollo Bionda',
  'Lollo Rosso',
  'Mash Potato',
  'Minced Beef',
  'Nile Perch',
  'Peanut Butter',
  'Pine Nuts',
  'Protein Powder',
  'Raw Onion',
  'Raw Tomato',
  'Red Meat',
  'Rice Noodles',
  'Risotto Rice',
  'Rock Melon',
  'Sea Bass',
  'Sea Bream',
  'Sesame Oil',
  'Snow Peas',
  'Sour cream',
  'Soy milk',
  'Soya meat',
  'Spring Onion',
  'Sweet Chili',
  'Sweet Potato',
  'Truffle Oil',
  'White Fish',
  'All Fish',
  'All Fruits',
  'All Nuts',
  'Baby corn',
  'Bok Choy',
  'Bulgur',
  'Almond',
  'Apple',
  'Apricot',
  'Asparagus',
  'Avacado',
  'Bacon',
  'Banana',
  'Basil',
  'Beans',
  'Beef',
  'Beetroot',
  'Blueberry',
  'Bread',
  'Broccoli',
  'Butter',
  'Butternut',
  'Cabbage',
  'Calamari',
  'Capsicum',
  'Carrot',
  'Cashew',
  'Cauliflower',
  'Cayenne',
  'Celery',
  'Chia',
  'Chicken',
  'Chickpeas',
  'Chili',
  'Cinnamon',
  'Cocoa',
  'Coconut',
  'Cod',
  'Coffee',
  'Coriander',
  'Corn',
  'Crab',
  'Cranberry',
  'Cucumber',
  'Cumin',
  'Dairy',
  'Dates',
  'Dill',
  'Edamame',
  'Egg',
  'Eggplant',
  'Fennel',
  'Ginger',
  'Gluten',
  'Grapes',
  'Honey',
  'Kale',
  'Ketchup',
  'Kimchi',
  'Kiwi',
  'Labneh',
  'Lamb',
  'Leeks',
  'Lemon',
  'Lentil',
  'Lettuce',
  'Mango',
  'Mayonnaise',
  'Meatloaf',
  'Milk',
  'Mushroom',
  'Mussel',
  'Mustard',
  'NA',
  'Nutmeg',
  'Nuts',
  'Oats',
  'Olives',
  'Orange',
  'Paneer',
  'Paprika',
  'Parsley',
  'Parsnip',
  'Pasta',
  'Peanuts',
  'Pineapple',
  'Pomegranate',
  'Potato',
  'Quinoa',
  'Radish',
  'Raisins',
  'Raspberry',
  'Rice',
  'Rosemary',
  'Saffron',
  'Salad',
  'Salmon',
  'Sausage',
  'Scallop',
  'Sesame',
  'Shrimp',
  'Soy',
  'Spicy',
  'Spinach',
  'Sprouts',
  'Strawberry',
  'Sugar',
  'Sumac',
  'Tabasco',
  'Tahina',
  'Tapioca',
  'Tofu',
  'Tortilla',
  'Tuna',
  'TURKEY',
  'Turmeric',
  'Vanilla',
  'Vinegar',
  'Walnut',
  'Yogurt',
  'Zaatar',
  'Zucchini',
];

/**
 * Takes a raw mealExclusion string (possibly stored as "all, fish" or "All Fish,Eggplant")
 * and returns a clean array of canonical phrases matched against EXCLUSION_LIST.
 *
 * Uses greedy longest-match, so "all fish" (2 consecutive tokens) becomes "All Fish"
 * instead of ["All", "Fish"]. Unrecognized tokens are kept as-is.
 */
export const groupExclusions = (rawString) => {
  if (!rawString) return [];

  // Build lowercase → canonical map for fast direct lookup
  const phraseMap = new Map(EXCLUSION_LIST.map((p) => [p.toLowerCase(), p]));

  // Split raw string into tokens (handles commas, semicolons, pipes, newlines)
  const tokens = String(rawString)
    .split(/[,;|\n\r]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const result = [];
  let i = 0;

  while (i < tokens.length) {
    // 1. Direct match — single token equals a known phrase (e.g. "All Fish" already grouped)
    const direct = phraseMap.get(tokens[i].toLowerCase());
    if (direct) {
      result.push(direct);
      i++;
      continue;
    }

    // 2. Greedy multi-token assembly — try to combine adjacent tokens into a known phrase
    //    e.g. tokens ["all","fish"] → "All Fish"
    //    EXCLUSION_LIST is sorted longest-first so we always try the most specific match first
    let found = false;
    for (const phrase of EXCLUSION_LIST) {
      const words = phrase.split(' ');
      if (words.length < 2) continue; // single-word phrases already handled above

      const slice = tokens.slice(i, i + words.length);
      if (
        slice.length === words.length &&
        slice.join(' ').toLowerCase() === phrase.toLowerCase()
      ) {
        result.push(phrase);
        i += words.length;
        found = true;
        break;
      }
    }

    if (!found) {
      // Unknown token — keep as-is
      result.push(tokens[i]);
      i++;
    }
  }

  return result;
};

/**
 * Umbrella exclusion phrases that should catch more than just their own
 * literal name — a customer excluding "All Nuts" needs to be blocked from a
 * meal whose ingredient is named "almond" or "cashew", not just one
 * literally named "nuts". Keys are lowercased canonical phrases (matching
 * what groupExclusions/EXCLUSION_LIST produce); values are the specific
 * ingredient names, also lowercased.
 *
 * NOTE: the nut list below reads "peanut, walnut, cashew, pistachio,
 * almond" — "Cashew" fills a gap the original request typo'd as "Cajun"
 * (not a nut); flag if that substitution is wrong.
 */
export const EXCLUSION_GROUPS = {
  'all nuts': ['peanut', 'peanuts', 'walnut', 'cashew', 'pistachio', 'almond'],
  'all fish': ['cream dory', 'nile perch', 'shrimp', 'salmon', 'squid', 'tuna', 'scallop'],
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
  const ex = String(exclusionPhrase || '').trim().toLowerCase();
  const t = String(term || '').trim().toLowerCase();
  if (!ex || !t) return false;
  if (ex === t) return true;
  const group = EXCLUSION_GROUPS[ex];
  if (group && group.includes(t)) return true;
  return containsWholePhrase(t, ex) || containsWholePhrase(ex, t);
};

/** True if `exclusionPhrase` matches any term in `terms` — see exclusionMatchesTerm. */
export const exclusionMatchesAny = (exclusionPhrase, terms) =>
  (terms || []).some((t) => exclusionMatchesTerm(exclusionPhrase, t));
