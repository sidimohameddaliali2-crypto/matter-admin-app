import User from '../models/User.js';
import Delivery from '../models/Delivery.js';

// Monthly driver scorecard: On-Time Delivery Rate, Average Delay, Delivery
// Update (status-compliance) Rate, and a weighted composite score.
//
// Recomputed from THIS CALENDAR MONTH's deliveries only — the 1st of the
// month through "now", in the local business timezone (LOCAL_TIMEZONE_OFFSET_MINUTES /
// BUSINESS_TZ_OFFSET_MINUTES) — so the numbers reset to a clean slate every
// month instead of averaging in years of history. `jobs/recalculateDriverKpis.js`
// also recomputes every driver once at local midnight, so the reset to a new
// month is visible immediately even before that driver's first delivery of it.
//
//   OTD Rate (%)    = onTime / totalAssigned * 100
//   Avg Delay (min) = sum(delay minutes) / count(LATE deliveries only)
//                     — on-time deliveries are excluded from this average
//                     entirely (not averaged in as 0), so a good day never
//                     dilutes how bad a late one actually was.
//   Update Rate (%) = deliveries with a logged outcome / totalAssigned * 100
//                     (delivered / completed / collected / failed count as
//                     "logged"; still pending/assigned/on_route/picked_up
//                     do not, even once their scheduled time has passed)
//   Driver Score    = w1*OTD% + w2*UpdateRate% - w3*AvgDelay, clamped 0-100
//
// A delivery counts as "on time" when it's delivered at or before its
// scheduled time, or within DRIVER_KPI_GRACE_MINUTES of it.
const DRIVER_KPI_GRACE_MINUTES = Number.parseInt(process.env.DRIVER_KPI_GRACE_MINUTES || '5', 10);
const DRIVER_KPI_WEIGHT_OTD = Number.parseFloat(process.env.DRIVER_KPI_WEIGHT_OTD || '0.5');
const DRIVER_KPI_WEIGHT_UPDATE = Number.parseFloat(process.env.DRIVER_KPI_WEIGHT_UPDATE || '0.4');
const DRIVER_KPI_WEIGHT_DELAY = Number.parseFloat(process.env.DRIVER_KPI_WEIGHT_DELAY || '1.0');

const TERMINAL_STATUSES = ['delivered', 'completed', 'collected', 'failed'];

const LOCAL_TZ_OFFSET_MINUTES = Number.parseInt(
  process.env.LOCAL_TIMEZONE_OFFSET_MINUTES || process.env.BUSINESS_TZ_OFFSET_MINUTES || '0',
  10
);
const LOCAL_TZ_OFFSET_MS = LOCAL_TZ_OFFSET_MINUTES * 60 * 1000;

// Start of the current calendar month in local time (as a UTC instant), plus
// "now" as the other edge of the month-to-date window, and the 'YYYY-MM'
// label these numbers reflect.
function currentMonthBoundsLocal() {
  const now = new Date();
  const local = new Date(now.getTime() + LOCAL_TZ_OFFSET_MS);
  const monthStartMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, 0, 0, 0, 0) - LOCAL_TZ_OFFSET_MS;
  const period = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
  return { monthStart: new Date(monthStartMs), now, period };
}

export async function recalculateDriverKPI(driverId, { assertOwned = async () => {}, throwOnError = false } = {}) {
  try {
    const { monthStart, now, period } = currentMonthBoundsLocal();

    // Everything assigned to this driver, due (scheduled) so far this month.
    // A delivery scheduled later today or later this month hasn't happened
    // yet, so it doesn't count against the driver until its own time comes —
    // this is what makes the scorecard grow day by day through the month.
    const deliveries = await Delivery.find({
      driver: driverId,
      type: 'Delivery',
      scheduledTime: { $gte: monthStart, $lte: now }
    }).select('scheduledTime deliveredTime completedAt status').lean();

    const totalDeliveries = deliveries.length;
    let onTimeDeliveries = 0;
    let lateDeliveries = 0;
    let updatedDeliveries = 0;
    let totalDelayMinutes = 0;

    for (const d of deliveries) {
      if (TERMINAL_STATUSES.includes(d.status)) updatedDeliveries += 1;

      const doneAt = d.deliveredTime || d.completedAt;
      if (!doneAt) continue; // never actually completed — not on-time, not late, no delay to measure

      const diffMinutes = Math.round((new Date(doneAt).getTime() - new Date(d.scheduledTime).getTime()) / 60000);
      if (diffMinutes <= DRIVER_KPI_GRACE_MINUTES) {
        onTimeDeliveries += 1;
      } else {
        lateDeliveries += 1;
        totalDelayMinutes += diffMinutes;
      }
    }

    const otdRate = totalDeliveries > 0 ? (onTimeDeliveries / totalDeliveries) * 100 : 0;
    const updateRate = totalDeliveries > 0 ? (updatedDeliveries / totalDeliveries) * 100 : 0;
    const avgDelayMinutes = lateDeliveries > 0 ? totalDelayMinutes / lateDeliveries : 0;

    const rawScore =
      DRIVER_KPI_WEIGHT_OTD * otdRate +
      DRIVER_KPI_WEIGHT_UPDATE * updateRate -
      DRIVER_KPI_WEIGHT_DELAY * avgDelayMinutes;
    const kpiScore = Math.max(0, Math.min(100, rawScore));

    await assertOwned();
    await User.findByIdAndUpdate(driverId, {
      'kpi.score': Math.round(kpiScore),
      // accuracyRate / avgLateTime are the pre-existing field names the UI
      // already reads (Drivers.js, DriverDetail.js) — kept so no front-end
      // change is required; they now hold the OTD rate and average delay
      // computed under this month-to-date formula instead of the old
      // all-time one.
      'kpi.accuracyRate': Math.round(otdRate),
      'kpi.avgLateTime': Math.round(avgDelayMinutes * 10) / 10,
      'kpi.updateRate': Math.round(updateRate),
      'kpi.totalDeliveries': totalDeliveries,
      'kpi.onTimeDeliveries': onTimeDeliveries,
      'kpi.lateDeliveries': lateDeliveries,
      'kpi.updatedDeliveries': updatedDeliveries,
      'kpi.period': period,
      'kpi.lastCalculatedAt': new Date()
    });
  } catch (error) {
    console.error('Recalculate KPI error:', error);
    if (throwOnError) throw error;
  }
}

// Recompute every driver's scorecard — used by the daily midnight job so a
// new month (or a day with no completed deliveries) still shows fresh
// month-to-date numbers instead of stale ones from whenever a driver last
// happened to complete a delivery.
export async function recalculateAllDriverKPIs(context = {}) {
  const drivers = await User.find({ role: 'driver' }).select('_id').lean();
  let processed = 0;
  for (const driver of drivers) {
    await recalculateDriverKPI(driver._id, { ...context, throwOnError: true });
    processed += 1;
  }
  return { processed };
}
