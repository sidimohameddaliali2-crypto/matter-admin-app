import { traceJob } from '../observability/telemetry.js';
import { recalculateAllDriverKPIs } from '../services/driverKpiService.js';

// Recompute every driver's month-to-date KPI scorecard once a day at local
// midnight. The scorecard is otherwise only recomputed when a driver
// actually completes a delivery (see recalculateDriverKPI call sites in
// routes/deliveries.js), so without this job a driver with nothing to
// deliver yet today — or on the 1st of a new month — would keep showing
// yesterday's (or last month's) numbers instead of resetting cleanly.

const RUN_HOUR = 0; // Midnight
const TIMEZONE_OFFSET_MINUTES = parseInt(process.env.LOCAL_TIMEZONE_OFFSET_MINUTES || '240', 10); // Default: UAE

export async function runRecalculateDriverKpisOnce() {
  return traceJob('driver-kpi-recalculation', async () => {
    try {
      const result = await recalculateAllDriverKPIs();
      console.log(`[DriverKPI] Recalculated KPIs for ${result.processed} driver(s).`);
      return result;
    } catch (err) {
      console.error('[DriverKPI] Error:', err.message);
      throw err;
    }
  });
}

export function startRecalculateDriverKpisJob() {
  const now = new Date();
  const nowLocal = new Date(now.getTime() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  const nextMidnight = new Date(nowLocal);
  nextMidnight.setHours(RUN_HOUR, 0, 0, 0);
  if (nowLocal >= nextMidnight) nextMidnight.setDate(nextMidnight.getDate() + 1);
  const msUntilMidnight = nextMidnight - nowLocal;

  setTimeout(() => {
    runRecalculateDriverKpisOnce();
    setInterval(runRecalculateDriverKpisOnce, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}
