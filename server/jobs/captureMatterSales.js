import { refreshMatterSales } from '../services/matterSalesService.js';

export function startCaptureMatterSalesJob() {
  if (!process.env.MATTER_API_BASE_URL || !process.env.MATTER_API_TOKEN) return;
  const run = () => refreshMatterSales().catch(() => console.warn('[MatterSales] Capture failed; previous observations retained.'));
  const timer = setTimeout(() => {
    run();
    const interval = setInterval(run, 60 * 60 * 1000);
    interval.unref?.();
  }, 60000);
  timer.unref?.();
}
