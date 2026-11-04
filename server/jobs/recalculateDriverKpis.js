import { scheduleDailyWork } from '../services/scheduledWork.js';
import { recalculateAllDriverKPIs } from '../services/driverKpiService.js';

// Recompute every driver's month-to-date KPI scorecard once a day at local
// midnight. The scorecard is otherwise only recomputed when a driver
// actually completes a delivery (see recalculateDriverKPI call sites in
// routes/deliveries.js), so without this job a driver with nothing to
// deliver yet today — or on the 1st of a new month — would keep showing
// yesterday's (or last month's) numbers instead of resetting cleanly.

export async function runRecalculateDriverKpisOnce(context = {}) {
  try {
    const result = await recalculateAllDriverKPIs(context);
    console.log(`[DriverKPI] Recalculated KPIs for ${result.processed} driver(s).`);
    return result;
  } catch (err) {
    console.error('[DriverKPI] Error:', err.message);
    throw err;
  }
}

export function startRecalculateDriverKpisJob() {
  return scheduleDailyWork({ name: 'driver-kpis', immediate: false, run: runRecalculateDriverKpisOnce });
}
