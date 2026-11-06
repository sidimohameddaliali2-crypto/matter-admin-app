export const SERVICE_TAXONOMY_VERSION = '2026-11-06.1';
export const SERVICE_RUBRIC_VERSION = '2026-11-06.1';
export const SERVICE_CATEGORIES = Object.freeze([
  ['ordering', 'Ordering'], ['renewal', 'Renewal'],
  ['account_link_access', 'Account and link access'], ['subscription_changes', 'Subscription changes'],
  ['coupons_discounts', 'Coupons and discounts'], ['delivery', 'Delivery'],
  ['wrong_meals', 'Wrong Meals'], ['wrong_nutrition', 'Wrong Nutrition'],
  ['refund_credit', 'Refund or credit'], ['food_quality', 'Food quality'], ['bag_pickup', 'Bag pickup'],
].map(([id, label]) => Object.freeze({ id, label })));
export const SERVICE_CATEGORY_IDS = SERVICE_CATEGORIES.map(c => c.id);
