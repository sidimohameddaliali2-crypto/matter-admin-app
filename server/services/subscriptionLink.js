import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import { MATCH_PROJECTION } from './customerMatchService.js';

// Point a Matter subscription at exactly one internal customer (issue #3).
//
// Linking has two writes — take the subscription off whoever had it, then put
// it on the target — and a failure between them used to leave the
// subscription with NO owner (the old link cleared, the new one never set).
// Both writes now run in one transaction (Atlas is a replica set, so
// transactions are available) and the target is verified to exist first.
//
// Concurrency: two relinks of the same subscription must not both win. They
// would not otherwise touch a common document when the subscription had no
// previous owner, so each transaction also bumps one per-subscription lock
// document — the resulting write conflict makes MongoDB serialize them, and
// the later one then sees (and replaces) the earlier owner.
// (The unique index on Customer.matterSubscriptionId is declared in the
// schema but the live index is non-unique, so this app logic is the only guard.)

export class LinkTargetNotFoundError extends Error {
  constructor(customerId) {
    super(`Customer "${customerId}" not found`);
    this.name = 'LinkTargetNotFoundError';
  }
}

const LOCK_COLLECTION = 'subscriptionlinklocks';

const isTransactionUnsupported = (err) =>
  err?.code === 20 ||
  err?.codeName === 'IllegalOperation' ||
  /Transaction numbers are only allowed|replica set|transactions are not supported/i.test(String(err?.message || ''));

async function ensureLockDoc(subId) {
  try {
    await Customer.db.collection(LOCK_COLLECTION).updateOne({ _id: subId }, { $setOnInsert: { version: 0 } }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err; // another request created it first — fine
  }
}

async function runTransactional(subId, customerId) {
  await ensureLockDoc(subId);
  const session = await mongoose.startSession();
  try {
    let customer = null;
    await session.withTransaction(async () => {
      // Serialize concurrent relinks of this subscription.
      await Customer.db.collection(LOCK_COLLECTION).updateOne({ _id: subId }, { $inc: { version: 1 } }, { session });
      await Customer.updateMany(
        { matterSubscriptionId: subId, customerId: { $ne: customerId } },
        { $set: { matterSubscriptionId: null } },
        { session }
      );
      customer = await Customer.findOneAndUpdate(
        { customerId },
        { $set: { matterSubscriptionId: subId } },
        { new: true, session }
      ).select(MATCH_PROJECTION);
      // Target vanished mid-flight: throwing aborts the transaction, which
      // also undoes the clear above.
      if (!customer) throw new LinkTargetNotFoundError(customerId);
    });
    return customer;
  } finally {
    await session.endSession();
  }
}

// Standalone MongoDB (e.g. the local docker-compose dev database) has no
// transactions: same steps, restoring the previous owners if the second write
// fails so the subscription is never left ownerless.
async function runCompensating(subId, customerId) {
  const previousOwners = await Customer.find({ matterSubscriptionId: subId, customerId: { $ne: customerId } })
    .select('_id')
    .lean();
  const previousIds = previousOwners.map((c) => c._id);
  if (previousIds.length > 0) {
    await Customer.updateMany({ _id: { $in: previousIds } }, { $set: { matterSubscriptionId: null } });
  }
  try {
    const customer = await Customer.findOneAndUpdate(
      { customerId },
      { $set: { matterSubscriptionId: subId } },
      { new: true }
    ).select(MATCH_PROJECTION);
    if (!customer) throw new LinkTargetNotFoundError(customerId);
    return customer;
  } catch (err) {
    if (previousIds.length > 0) {
      await Customer.updateMany({ _id: { $in: previousIds } }, { $set: { matterSubscriptionId: subId } })
        .catch((restoreErr) => console.error('Failed to restore previous subscription owner:', restoreErr.message));
    }
    throw err;
  }
}

export async function relinkSubscription({ subId, customerId }) {
  // The target must exist before anything is cleared.
  const target = await Customer.findOne({ customerId }).select('_id');
  if (!target) throw new LinkTargetNotFoundError(customerId);

  try {
    return await runTransactional(subId, customerId);
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err;
    return runCompensating(subId, customerId);
  }
}
