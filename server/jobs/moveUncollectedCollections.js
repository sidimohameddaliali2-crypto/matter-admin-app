import { traceJob } from '../observability/telemetry.js';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';

// Move uncollected collection deliveries to next day at midnight
// Only applies to type: Collection + status: assigned
// Resets assignment, keeps bag links, updates timeline

const RUN_HOUR = 0; // Midnight
const TIMEZONE_OFFSET_MINUTES = parseInt(process.env.LOCAL_TIMEZONE_OFFSET_MINUTES || '240', 10); // Default: UAE

function getTodayRange() {
  const nowUTC = new Date();
  const nowLocal = new Date(nowUTC.getTime() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  const todayString = nowLocal.toISOString().split('T')[0];
  const localMidnight = new Date(todayString + 'T00:00:00.000Z');
  const startOfDay = new Date(localMidnight.getTime() - TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startOfDay, endOfDay };
}

async function moveUncollectedCollections() {
  const { startOfDay, endOfDay } = getTodayRange();
  const filter = {
    type: 'Collection',
    status: 'assigned',
    scheduledTime: { $gte: startOfDay, $lte: endOfDay }
  };

  const deliveries = await Delivery.find(filter).exec();
  let moved = 0;

  for (const d of deliveries) {
    // Move to next day
    const nextDay = new Date(d.scheduledTime.getTime() + 24 * 60 * 60 * 1000);
    d.scheduledTime = nextDay;
    d.status = 'pending';
    d.driver = null;
    d.timeline.push({
      status: 'moved_to_next_day',
      timestamp: new Date(),
      notes: 'Automatically moved to next day (uncollected)'
    });
    await d.save();
    moved++;
  }
  return { moved };
}

export async function runMoveUncollectedCollectionsOnce() {
  return traceJob('move-uncollected-collections', async () => {
    try {
      const result = await moveUncollectedCollections();
      console.log(`[AutoMove] Moved ${result.moved} uncollected collections to next day.`);
      return result;
    } catch (err) {
      console.error('[AutoMove] Error:', err.message);
      throw err;
    }
  });
}

export function startMoveUncollectedCollectionsJob() {
  // Calculate ms until next midnight local time
  const now = new Date();
  const nowLocal = new Date(now.getTime() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  const nextMidnight = new Date(nowLocal);
  nextMidnight.setHours(RUN_HOUR, 0, 0, 0);
  if (nowLocal >= nextMidnight) nextMidnight.setDate(nextMidnight.getDate() + 1);
  const msUntilMidnight = nextMidnight - nowLocal;

  setTimeout(() => {
    runMoveUncollectedCollectionsOnce();
    setInterval(runMoveUncollectedCollectionsOnce, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}
