import { normalizeMatterAllergens } from './matterAllergens.js';

// Matter is the sole authority. Never discover, merge or fall back to an
// internal Customer profile, including when Matter's list is unavailable.
export function resolveMenuAllergyProfile(nutrition) {
  const allergies = normalizeMatterAllergens(nutrition?.allergens);
  return { allergies: allergies || [], allergiesAvailable: allergies !== null, allergySource: 'matter' };
}

export function withMenuAllergyProfiles(inputs) {
  return inputs.map(input => ({ ...input, allergyProfile: resolveMenuAllergyProfile(input) }));
}
