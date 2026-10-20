import { buildRealModel } from './MenuSelectionLink';

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
