import { syncCustomerTrackerVisits } from '../services/truckoomVisitSync.js';

export function startCustomerTrackerVisitsJob(io) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await syncCustomerTrackerVisits({ io }); }
    catch { console.warn('Customer tracker visit sync failed; retrying next cycle'); }
    finally { running = false; }
  };
  run();
  return setInterval(run, 2 * 60 * 1000);
}
