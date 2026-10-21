import { buildRealModel, expandSaturdaySkips } from './MenuSelectionLink';
import { allergenMatchesAny } from '../../constants/exclusionList';

jest.mock('../../utils/api', () => ({ get: jest.fn(), post: jest.fn() }));

test('reopening the menu keeps saved Wednesday, Friday and Saturday skips visible alongside active deliveries', () => {
  const dates = ['2099-10-21', '2099-10-22', '2099-10-23', '2099-10-24'];
  const model = buildRealModel({ meals: dates.map((date) => ({ date, mealType: 'main', items: [] })) }, {
    weekend: false,
    deliveryDates: ['2099-10-22'],
    skippedDays: ['2099-10-21', '2099-10-23', '2099-10-24'].map((date) => ({ date, pauseStatus: 'success' })),
  });
  expect(model.dayKeys).toEqual(dates);
});

test('allergen checking includes declared categories and hidden sauce, portion and garnish ingredients', () => {
  const model = buildRealModel({ meals: [{ date: '2099-10-21', mealType: 'main', items: [{
    _id: 'meal', mealName: 'Fixture', allergens: ['Dairy'],
    portionIngredients: [{ name: 'Whole Milk', visible: false }],
    sauceIngredients: [{ name: 'Peanut Butter', visible: false }],
    garnish: 'Sesame',
  }] }] }, { deliveryDates: ['2099-10-21'] });
  const terms = model.meals[0].allergenMatchTokens;
  expect(allergenMatchesAny('Milk', terms)).toBe(true);
  expect(allergenMatchesAny('Peanuts', terms)).toBe(true);
  expect(allergenMatchesAny('Sesame', terms)).toBe(true);
  expect(model.meals[0].proteinText).not.toContain('Whole Milk');
});

test('Saturday includes an eligible Sunday across menu or month boundaries; Sunday alone does not include Saturday', () => {
  const dates = ['2026-10-31', '2026-11-01'];
  expect(expandSaturdaySkips(['2026-10-31'], dates)).toEqual(dates);
  expect(expandSaturdaySkips(['2026-11-01'], dates)).toEqual(['2026-11-01']);
  expect(expandSaturdaySkips(['2026-10-31', '2026-11-01'], dates)).toEqual(dates);
  expect(expandSaturdaySkips(['2026-10-31'], ['2026-10-31'])).toEqual(['2026-10-31']);
});
