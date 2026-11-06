import ScheduledWork from '../models/ScheduledWork.js';

// Shared atomic store fixture behind the real Mongo adapter: no network or DB.
export function mockScheduledWork(t) {
  const records = new Map();
  const matches = (row, filter) => row && (!filter.owner || row.owner === filter.owner)
    && (!filter.completedSlot || row.completedSlot < filter.completedSlot.$lt)
    && (!filter.$expr || (filter.$expr.$gt ? row.leaseUntil > Date.now() : row.leaseUntil <= Date.now()));
  t.mock.method(ScheduledWork, 'updateOne', async (filter, update) => {
    if (update.$setOnInsert) {
      if (!records.has(filter._id)) records.set(filter._id, { ...update.$setOnInsert });
      return { matchedCount: 1 };
    }
    const row = records.get(filter._id);
    if (!matches(row, filter)) return { matchedCount: 0 };
    if (Array.isArray(update)) row.leaseUntil = Date.now() + update[0].$set.leaseUntil.$add[1];
    else { Object.assign(row, update.$set); if (update.$unset?.owner !== undefined) delete row.owner; }
    return { matchedCount: 1 };
  });
  t.mock.method(ScheduledWork, 'findOneAndUpdate', (filter, update) => ({ lean: async () => {
    const row = records.get(filter._id);
    if (!matches(row, filter)) return null;
    row.owner = update[0].$set.owner.$literal;
    row.leaseUntil = Date.now() + update[0].$set.leaseUntil.$add[1];
    return { ...row };
  } }));
  t.mock.method(ScheduledWork, 'findById', id => ({ select: () => ({ lean: async () => records.get(id) }) }));
  return records;
}
