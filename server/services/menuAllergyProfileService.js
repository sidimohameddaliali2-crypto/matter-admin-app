import { normalizeMatterAllergens } from './matterAllergens.js';

// Matter is the sole authority. Never discover, merge or fall back to an
// internal Customer profile, including when Matter's list is unavailable.
export async function resolveMenuAllergyProfile(nutrition) {
  const allergies = normalizeMatterAllergens(nutrition?.allergens);
  return { allergies: allergies || [], allergiesAvailable: allergies !== null, allergySource: 'matter' };
}
