import { salesDashboardDates, sumSalesDays, salesTrend, deliveryRevenueLabel, hasSalesComparisonCoverage } from './salesDashboard';

test('equal seven-day windows show no decline when daily payments are unchanged', () => {
  const dates = salesDashboardDates('2026-10-21');
  expect(dates.weekStart).toBe('2026-10-15');
  expect(dates.priorWeekStart).toBe('2026-10-08');
  expect(dates.priorWeekEnd).toBe('2026-10-14');
  const days = Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(i + 8).padStart(2, '0')}`, paymentsReceived: 100 }));
  expect(salesTrend(sumSalesDays(days, dates.weekStart, dates.today), sumSalesDays(days, dates.priorWeekStart, dates.priorWeekEnd))).toBe(0);
});

test('month comparison clamps shorter months and covers fourteen days at a month/year boundary', () => {
  expect(salesDashboardDates('2026-03-31').previousEnd).toBe('2026-02-28');
  const january = salesDashboardDates('2026-01-01');
  expect(january.previousStart).toBe('2025-12-01');
  expect(january.priorWeekStart).toBe('2025-12-19');
});

test('unavailable pricing never renders a false zero and partial revenue is labeled known', () => {
  expect(deliveryRevenueLabel({ completed: 10, unpriced: 10, knownDeliveryRevenue: 0 })).toBe('Unavailable');
  expect(deliveryRevenueLabel({ completed: 10, unpriced: 1, knownDeliveryRevenue: 450 })).toBe('Known AED 450');
  expect(deliveryRevenueLabel({ completed: 1, unpriced: 0, knownDeliveryRevenue: 0 })).toBe('AED 0');
});

test('comparisons require capture coverage before both periods and suppress unknown payments', () => {
  expect(hasSalesComparisonCoverage({ captureStartedOn: '2026-10-21' }, '2026-10-08')).toBe(false);
  expect(hasSalesComparisonCoverage({ captureStartedOn: '2026-10-01' }, '2026-10-08')).toBe(true);
  expect(salesTrend({ paymentsReceived: 200, unknownPayments: 1 }, { paymentsReceived: 100 })).toBeNull();
});
