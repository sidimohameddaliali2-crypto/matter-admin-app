import Delivery from '../models/Delivery.js';

export const matterImportKey = (subscriptionId, serviceDate) => `${serviceDate}:${String(subscriptionId)}`;

export async function ensureMatterDeliveryIdempotency() {
  // Explicitly await the unique index even when production autoIndex is off.
  // Historical/manual rows without a key are excluded; no backfill is needed.
  await Delivery.collection.createIndex({ matterImportKey: 1 }, {
    name: 'matter_import_obligation_unique', unique: true,
    partialFilterExpression: { matterImportKey: { $type: 'string' } }
  });
}

export async function insertMatterDelivery(snapshot, serviceDate) {
  const key = matterImportKey(snapshot.matterSubscriptionId, serviceDate);
  try {
    await Delivery.create({ ...snapshot, matterImportKey: key });
    return true;
  } catch (error) {
    // A replacement worker may have inserted after our read/lease check.
    // Only this exact unique-key collision means the obligation already exists.
    if (error.code === 11000 && (error.keyPattern?.matterImportKey === 1 || error.keyValue?.matterImportKey === key)) return false;
    throw error;
  }
}
