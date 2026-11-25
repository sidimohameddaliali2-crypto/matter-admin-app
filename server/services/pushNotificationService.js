import { Expo } from 'expo-server-sdk';
import User from '../models/User.js';

const expo = new Expo();

const formatTime = (scheduledTime) => {
  if (!scheduledTime) return '';
  const date = new Date(scheduledTime);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

const COPY = {
  delivery_created: (delivery) => {
    const time = formatTime(delivery.scheduledTime);
    return {
      title: 'New delivery assigned',
      body: `${delivery.customerName || 'A customer'} — ${delivery.zone || delivery.address || 'no zone'}${time ? `, ${time}` : ''}`
    };
  },
  delivery_reassigned: (delivery) => ({
    title: 'Delivery reassigned to you',
    body: `${delivery.customerName || 'A customer'} — ${delivery.zone || delivery.address || 'no zone'}`
  }),
  delivery_removed: (delivery) => ({
    title: 'Delivery removed from your list',
    body: `${delivery.customerName || 'A delivery'} was reassigned to another driver`
  }),
  delivery_updated: (delivery) => ({
    title: 'Delivery updated',
    body: `${delivery.customerName || 'A delivery'}: status changed to ${delivery.status}`
  })
};

/**
 * Shared low-level sender: pushes one title/body/data payload to every
 * device registered to a driver, drops tokens Expo reports as no-longer-
 * registered, and never throws past its own boundary — callers should fire
 * this with `.catch(...)`, never `await` it in a way that would block the
 * HTTP response, same pattern as `sendAndLogSlack`.
 */
async function sendPushToDriver(driverId, title, body, data) {
  if (process.env.DISABLE_DRIVER_PUSH === '1') return;
  try {
    if (!driverId) return;

    const user = await User.findById(driverId).select('pushTokens');
    if (!user || !user.pushTokens || user.pushTokens.length === 0) return;

    const validTokens = user.pushTokens
      .map((entry) => entry.token)
      .filter((token) => Expo.isExpoPushToken(token));

    if (validTokens.length === 0) return;

    const messages = validTokens.map((token) => ({
      to: token,
      sound: 'default',
      title,
      body,
      data
    }));

    const chunks = expo.chunkPushNotifications(messages);
    const staleTokens = [];

    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        tickets.forEach((ticket, i) => {
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            staleTokens.push(chunk[i].to);
          }
        });
      } catch (chunkError) {
        console.warn('pushNotificationService: chunk send failed:', chunkError?.message || chunkError);
      }
    }

    if (staleTokens.length > 0) {
      await User.findByIdAndUpdate(driverId, {
        $pull: { pushTokens: { token: { $in: staleTokens } } }
      });
    }
  } catch (error) {
    console.warn('pushNotificationService: failed to send push:', error?.message || error);
  }
}

/**
 * Send an Expo push notification to every device registered to a driver, for
 * a single-delivery event.
 *
 * @param {Object} params
 * @param {string} params.driverId
 * @param {'delivery_created'|'delivery_reassigned'|'delivery_removed'|'delivery_updated'} params.type
 * @param {Object} params.delivery - plain delivery fields used for message copy (customerName, zone, address, deliveryTime, status) and the deep-link id (_id)
 */
export async function sendDeliveryPushToDriver({ driverId, type, delivery }) {
  const buildCopy = COPY[type];
  if (!buildCopy) {
    console.warn('pushNotificationService: unknown notification type', type);
    return;
  }
  const { title, body } = buildCopy(delivery);
  const deliveryId = delivery._id?.toString?.() || String(delivery._id);
  await sendPushToDriver(driverId, title, body, { type, deliveryId });
}

/**
 * Send a single batched push to a driver after a route plan is applied
 * (Optimize Routes → Apply). This is the main day-to-day path deliveries
 * actually get assigned to drivers through, and — unlike the single-delivery
 * create/assign/update paths above — it previously sent no signal to the
 * driver at all (no push, no socket event), so a route only ever showed up
 * once the driver happened to reopen the app and it re-fetched. One push per
 * driver here (not one per stop) to avoid spamming a driver with dozens of
 * notifications for a single route assignment.
 *
 * @param {Object} params
 * @param {string} params.driverId
 * @param {number} params.stopCount
 */
export async function sendRouteAssignedPushToDriver({ driverId, stopCount }) {
  if (!stopCount || stopCount <= 0) return;
  const title = 'Your route is ready';
  const body =
    stopCount === 1
      ? '1 delivery assigned for today. Tap to view your route.'
      : `${stopCount} deliveries assigned for today. Tap to view your route.`;
  await sendPushToDriver(driverId, title, body, { type: 'route_assigned', stopCount });
}
