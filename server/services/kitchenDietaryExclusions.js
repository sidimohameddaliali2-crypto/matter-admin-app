export const usesKitchenDietaryExclusions = nutrition =>
  String(nutrition?.plan_name || '').trim().toLowerCase() !== 'matter core';

export const kitchenDietaryExclusions = nutrition => usesKitchenDietaryExclusions(nutrition) ? nutrition?.exclusions : [];
