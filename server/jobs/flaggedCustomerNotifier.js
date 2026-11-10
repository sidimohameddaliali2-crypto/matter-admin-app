import axios from 'axios';
import { scheduleWork, withScheduledWork } from '../services/scheduledWork.js';
import { toBusinessDateKey } from '../utils/businessDate.js';
import Bag from '../models/Bag.js';
import Delivery from '../models/Delivery.js';
import FlaggedAlert from '../models/FlaggedAlert.js';

const DEFAULT_THRESHOLD = parseInt(process.env.FLAGGED_BAG_THRESHOLD || '3', 10);

function buildCustomerKey(customerId, customerName) {
  if (customerId && String(customerId).trim()) return String(customerId).trim().toLowerCase();
  if (customerName && String(customerName).trim()) return String(customerName).trim().toLowerCase();
  return null;
}

async function findFlaggedCustomers(threshold = DEFAULT_THRESHOLD) {
  // Aggregate bags grouped by customer key
  const pipeline = [
    { $match: { 'assignedTo.customer': { $exists: true, $ne: null } } },
    { $project: {
        bagId: 1,
        customerId: '$assignedTo.customer.customerId',
        customerName: '$assignedTo.customer.customerName',
        assignedTo: '$assignedTo',
      }
    },
    { $addFields: {
        key: { $ifNull: ['$customerId', '$customerName'] }
      }
    },
    { $match: { key: { $ne: null } } },
    { $group: {
        _id: { key: '$key' },
        bags: { $push: { _id: '$_id', bagId: '$bagId', assignedTo: '$assignedTo' } },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gte: threshold } } }
  ];

  const results = await Bag.aggregate(pipeline).exec();

  // Normalize to objects
  return results.map(r => ({
    key: String(r._id.key).toLowerCase(),
    bagCount: r.count,
    bagIds: r.bags.map(b => b.bagId),
    bags: r.bags
  }));
}

async function hasCollectionAssignedForCustomer(key) {
  if (!key) return false;
  // try by customerId first then by name
  // search deliveries with taskType 'Bag Collection' and matching customerId or customerName with active statuses
  const q = {
    taskType: 'Bag Collection',
    $or: [
      { customerId: { $regex: `^${escapeRegex(key)}$`, $options: 'i' } },
      { customerName: { $regex: `^${escapeRegex(key)}$`, $options: 'i' } }
    ],
    status: { $in: ['pending', 'assigned', 'on_route'] }
  };
  const found = await Delivery.findOne(q).lean().exec();
  return !!found;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sendSlackMessage(payloadText) {
  // Check if Slack notifications are enabled
  if (process.env.ENABLE_SLACK_NOTIFICATIONS === '0') {
    console.log('Slack notifications disabled; skipping message send');
    return;
  }

  const webhookUrl = process.env.SLACK_BAG_COLLECTION_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_BAG_COLLECTION_WEBHOOK_URL not configured');
  await axios.post(webhookUrl, { text: payloadText }, { timeout: 8000 });
}

export const runFlaggedNotifierOnce = (threshold = DEFAULT_THRESHOLD) =>
  withScheduledWork('flagged-notifier', context => notifyFlaggedCustomers(threshold, context));

async function notifyFlaggedCustomers(threshold, { assertOwned }) {
  try {
    const flagged = await findFlaggedCustomers(threshold);
    if (!Array.isArray(flagged) || flagged.length === 0) return { sent: 0 };

    let sentCount = 0, failed = 0;

    for (const c of flagged) {
      await assertOwned();
      const key = c.key;

      // check if a collection task already exists for this customer
      const assigned = await hasCollectionAssignedForCustomer(key);
      if (assigned) continue; // skip sending

      // check last sent timestamp
      const existing = await FlaggedAlert.findOne({ key }).exec();
      const today = new Date();
      const alreadySentToday = existing && existing.lastSent && toBusinessDateKey(existing.lastSent) === toBusinessDateKey(today);
      if (alreadySentToday) continue; // already sent today

      // Prepare payload
      const name = existing?.customerName || c.bags[0]?.assignedTo?.customer?.customerName || null;
      const id = existing?.customerId || c.bags[0]?.assignedTo?.customer?.customerId || null;
      const bagIds = c.bagIds || [];

      const textLines = [];
      textLines.push('*Flagged Customer - Automatic Daily Alert*');
      if (name) textLines.push(`*Name:* ${name}`);
      if (id) textLines.push(`*Customer ID:* ${id}`);
      textLines.push(`*Bags:* ${c.bagCount}`);
      if (bagIds.length > 0) textLines.push(`*Bag IDs:* ${bagIds.slice(0, 20).join(', ')}${bagIds.length > 20 ? ' (and more...)' : ''}`);

      try {
        await assertOwned();
        // Incoming webhooks offer no exactly-once acknowledgement protocol:
        // a process crash after Slack accepts but before lastSent is stored
        // can still cause a retry. The shared lease prevents concurrent sends.
        await sendSlackMessage(textLines.join('\n'));
        await assertOwned();
        sentCount++;

        // upsert flagged alert record
        await FlaggedAlert.findOneAndUpdate({ key }, { key, customerName: name, customerId: id, lastSent: new Date() }, { upsert: true }).exec();
      } catch (err) {
        if (err.code === 'WORK_LEASE_LOST') throw err;
        failed++;
        console.error('Failed to send Slack alert for', key, err.message);
      }
    }

    return { sent: sentCount, failed, complete: failed === 0 };
  } catch (err) {
    console.error('Error in flagged notifier:', err.message);
    throw err;
  }
}

export function startFlaggedNotifier(intervalMs = 24 * 60 * 60 * 1000, threshold = DEFAULT_THRESHOLD) {
  return scheduleWork({ name: 'flagged-customer-alerts', intervalMs,
    run: () => runFlaggedNotifierOnce(threshold) });
}
