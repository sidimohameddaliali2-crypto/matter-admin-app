import Delivery from '../models/Delivery.js';
import { MATTER_IMPORT_IDENTITIES, matterImportIdentityKeys } from '../config/matterImportIdentity.js';

export const matterImportKey = (subscriptionId, serviceDate) => `${serviceDate}:${String(subscriptionId)}`;

export async function ensureMatterDeliveryIdempotency() {
  // Explicitly await the unique index even when production autoIndex is off.
  // Historical/manual rows without a key are excluded; no backfill is needed.
  for (const [field, name] of MATTER_IMPORT_IDENTITIES) {
    await Delivery.collection.createIndex({ [field]: 1 }, {
      name, unique: true, partialFilterExpression: { [field]: { $type: 'string' } }
    });
  }
}

export async function insertMatterDelivery(snapshot, serviceDate) {
  const keys = matterImportIdentityKeys(snapshot, serviceDate);
  try {
    await Delivery.create({ ...snapshot, ...keys });
    return true;
  } catch (error) {
    // A replacement worker may have inserted after our read/lease check.
    // A renewal can change subscription ID while still being the same stop.
    if (error.code === 11000 && Object.entries(keys).some(([field, key]) =>
      error.keyPattern?.[field] === 1 || error.keyValue?.[field] === key)) return false;
    throw error;
  }
}
