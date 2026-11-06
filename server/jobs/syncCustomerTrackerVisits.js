import { scheduleWork } from '../services/scheduledWork.js';
import { syncCustomerTrackerVisits } from '../services/truckoomVisitSync.js';

export function startCustomerTrackerVisitsJob(io) {
  // The sync service also retains its per-operation tracker lease.
  return scheduleWork({ name: 'customer-tracker-visits', intervalMs: 120000,
    run: async ({ assertOwned }) => {
      await assertOwned();
      const result = await syncCustomerTrackerVisits({ io });
      return result?.busy ? { skipped: true, reason: 'busy' } : result;
    } });
}
