export const addSalesDays = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
export function salesDashboardDates(today) {
  const [year, month, day] = today.split('-').map(Number);
  const previousStart = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  const previousLastDay = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  return { monthStart: today.slice(0, 8) + '01', previousStart,
    previousEnd: previousStart.slice(0, 8) + String(Math.min(day, previousLastDay)).padStart(2, '0'),
    weekStart: addSalesDays(today, -6), priorWeekStart: addSalesDays(today, -13), priorWeekEnd: addSalesDays(today, -7),
    from: previousStart < addSalesDays(today, -13) ? previousStart : addSalesDays(today, -13), today };
}
export function sumSalesDays(days, from, to) {
  return days.filter((day) => day.day >= from && day.day <= to).reduce((sum, day) => {
    for (const key of ['paymentsReceived', 'knownDeliveryRevenue', 'orders', 'completed', 'additional', 'unpriced', 'unknownPayments']) sum[key] += day[key] || 0;
    return sum;
  }, { paymentsReceived: 0, knownDeliveryRevenue: 0, orders: 0, completed: 0, additional: 0, unpriced: 0, unknownPayments: 0 });
}
export const salesTrend = (current, previous) => current.unknownPayments || previous.unknownPayments || !previous.paymentsReceived
  ? null : (current.paymentsReceived - previous.paymentsReceived) / previous.paymentsReceived * 100;
export const hasSalesComparisonCoverage = (report, start) => !!report?.captureStartedOn && report.captureStartedOn < start && !report.unidentifiedPayments;
export const deliveryRevenueLabel = (period) => period.completed > 0 && period.unpriced === period.completed ? 'Unavailable'
  : `${period.unpriced ? 'Known ' : ''}AED ${period.knownDeliveryRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
