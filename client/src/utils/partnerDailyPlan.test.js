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


test.each(['populated', 'raw'])('retry reconciles removed and changed draft items (%s IDs) before submission', async idFormat => {
  const day = {
    ...makePlanDay('2099-01-05'),
    items: {
      a: { id: 'a', name: 'Meal A', quantity: 2, price: 20 },
      c: { id: 'c', name: 'Meal C', quantity: 3, price: 10 }
    }
  };
  const stored = new Map();
  let attempts = 0;
  let accepted;
  const api = {
    get: jest.fn(async () => ({
      data: { success: true, data: {
        status: 'draft',
        lines: [...stored].map(([id, quantity]) => ({
          menuItem: idFormat === 'populated' ? { _id: id } : id, quantity
        }))
      } }
    })),
    post: jest.fn(async (path, body) => {
      if (path === '/partner/orders') {
        // Match the real server: omitted items are retained; only zero deletes.
        body.lines.forEach(line => line.quantity === 0
          ? stored.delete(line.menuItemId)
          : stored.set(line.menuItemId, line.quantity));
        return { data: { success: true, data: { _id: 'draft-order' } } };
      }
      attempts++;
      if (attempts === 1) throw new Error('Submission failed after saving the draft');
      accepted = new Map(stored);
      return { data: { success: true, data: { _id: 'draft-order', status: 'submitted' } } };
    })
  };
  const saved = id => { day.orderId = id; };
  await expect(submitPlanDay(api, day, saved)).rejects.toThrow(/Submission failed/);
  expect(stored.get('a')).toBe(2);
  delete day.items.a;
  day.items.b = { id: 'b', name: 'Meal B', quantity: 1, price: 30 };
  day.items.c.quantity = 1;

  await expect(submitPlanDay(api, day, saved)).resolves.toBe('draft-order');
  const retry = api.post.mock.calls.filter(([path]) => path === '/partner/orders')[1][1];
  expect(retry.lines).toContainEqual({ menuItemId: 'a', quantity: 0 });
  expect(retry.lines.filter(line => line.menuItemId === 'c')).toEqual([{ menuItemId: 'c', quantity: 1 }]);
  expect(accepted.has('a')).toBe(false);
  expect([...accepted].sort()).toEqual([['b', 1], ['c', 1]]);
  const acceptedTotal = [...accepted].reduce((sum, [id, quantity]) => sum + day.items[id].price * quantity, 0);
  expect(acceptedTotal).toBe(dayTotal(day));
});


test.each([undefined, [{ menuItem: null, quantity: 1 }]])('retry stops before writes when stored draft items cannot be verified (%j)', async lines => {
  const day = { ...makePlanDay('2099-01-05'), orderId: 'draft', items: {} };
  const api = {
    get: jest.fn(async () => ({ data: { success: true, data: { status: 'draft', lines } } })),
    post: jest.fn()
  };
  await expect(submitPlanDay(api, day, jest.fn())).rejects.toThrow(/saved draft/);
  expect(api.post).not.toHaveBeenCalled();
});
