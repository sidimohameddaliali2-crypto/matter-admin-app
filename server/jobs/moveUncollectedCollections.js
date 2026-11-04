import { scheduleDailyWork } from '../services/scheduledWork.js';
import Delivery from '../models/Delivery.js';

// Move uncollected collection deliveries to next day at midnight
// Only applies to type: Collection + status: assigned
// Resets assignment, keeps bag links, updates timeline

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

async function moveUncollectedCollections({ assertOwned = async () => {} } = {}) {
  const { startOfDay, endOfDay } = getTodayRange();
  const filter = {
    type: 'Collection',
    status: 'assigned',
    scheduledTime: { $gte: startOfDay, $lte: endOfDay }
  };

  const deliveries = await Delivery.find(filter).exec();
  let moved = 0;

  for (const d of deliveries) {
    await assertOwned();
    // Compare-and-set prevents a retry/expired worker from moving the same
    // row again or overwriting a dispatcher's concurrent assignment change.
    const result = await Delivery.updateOne({ _id: d._id, type: 'Collection', status: 'assigned', driver: d.driver ?? null,
      scheduledTime: d.scheduledTime }, { $set: {
      scheduledTime: new Date(d.scheduledTime.getTime() + 86400000), status: 'pending', driver: null,
    }, $push: { timeline: { status: 'moved_to_next_day', timestamp: new Date(),
      notes: 'Automatically moved to next day (uncollected)' } } });
    moved += result.modifiedCount;

  }
  return { moved };
}

export async function runMoveUncollectedCollectionsOnce(context = {}) {
  try {
    const result = await moveUncollectedCollections(context);
    console.log(`[AutoMove] Moved ${result.moved} uncollected collections to next day.`);
    return result;
  } catch (err) {
    console.error('[AutoMove] Error:', err.message);
    throw err;
  }
}

export function startMoveUncollectedCollectionsJob() {
  return scheduleDailyWork({ name: 'move-uncollected-collections', immediate: false, run: runMoveUncollectedCollectionsOnce });
}
