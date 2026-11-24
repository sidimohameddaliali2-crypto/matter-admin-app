import mongoose from 'mongoose';
import { matterImportJobs } from '../services/matterImportJobService.js';

export function startMatterImportWorker() {
  // This consumes explicitly queued button requests. It does not enable the
  // separate automatic daily import or enqueue any dates on startup.
  const tick = () => {
    if (mongoose.connection.readyState !== 1) return;
    matterImportJobs.tick().catch(() => console.error('[MatterImportWorker] Job queue unavailable; will retry.'));
  };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return timer;
}
