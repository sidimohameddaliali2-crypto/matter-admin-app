import { scheduleWork } from '../services/scheduledWork.js';
import { refreshMatterSales } from '../services/matterSalesService.js';

export function startCaptureMatterSalesJob() {
  if (!process.env.MATTER_API_BASE_URL || !process.env.MATTER_API_TOKEN) return;
  return scheduleWork({ name: 'matter-sales-capture', intervalMs: 3600000,
    run: async ({ assertOwned }) => { await assertOwned(); return refreshMatterSales({ assertOwned }); } });
}
