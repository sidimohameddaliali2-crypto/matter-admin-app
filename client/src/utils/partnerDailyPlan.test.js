import { deliveryDays, makePlanDay, dayTotal, assertDayReady, quotePlanDay, submitPlanDay } from './partnerDailyPlan';
test('15 calendar days includes every delivery day except Sundays', () => {
  const dates = deliveryDays('2099-01-05', '2099-01-19');
  expect(dates).toHaveLength(13);
  expect(new Set(dates).size).toBe(13);
  expect(dates.every(d => new Date(d + 'T00:00:00Z').getUTCDay() !== 0)).toBe(true);
});
test('invalid and excessive ranges fail', () => {
  for (const pair of [['2099-02-31', '2099-03-03'], ['2099-01-07', '2099-01-05'], ['2099-01-01', '2099-12-31']]) expect(() => deliveryDays(...pair)).toThrow();
});
test('minimum is per day and unavailable items cannot disappear', () => {
  const day = {
    ...makePlanDay('2099-01-05'),
    items: {
      a: {
        id: 'a',
        name: 'Meal A',
        quantity: 1,
        price: 20
      }
    }
  };
  expect(dayTotal(day)).toBe(20);
  expect(() => assertDayReady(day, 40)).toThrow(/Minimum per delivery/);
  expect(() => quotePlanDay(day, [])).toThrow(/no longer available/);
});
test('retry recovers an accepted order without rewriting it', async () => {
  const day = {
    ...makePlanDay('2099-01-05'),
    orderId: 'accepted',
    items: {
      a: {
        id: 'a',
        quantity: 2,
        price: 20
      }
    }
  };
  const api = {
    get: jest.fn(async () => ({
      data: {
        success: true,
        data: {
          status: 'submitted',
          deliveryTime: day.window,
          lines: [{
            menuItem: {
              _id: 'a'
            },
            quantity: 2
          }]
        }
      }
    })),
    post: jest.fn()
  };
  await expect(submitPlanDay(api, day, jest.fn())).resolves.toBe('accepted');
  expect(api.post).not.toHaveBeenCalled();
  day.items.a.quantity = 3;
  await expect(submitPlanDay(api, day, jest.fn())).rejects.toThrow(/different items/);
});
