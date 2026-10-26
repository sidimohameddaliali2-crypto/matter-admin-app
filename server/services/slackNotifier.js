import axios from 'axios';
import SlackLog from '../models/SlackLog.js';

/**
 * Send a message to Slack via webhook and log it to DB
 * @param {Object} params
 * @param {string} params.type - logical type e.g. 'manual_delivery','delivery_change','flagged_customer'
 * @param {string} params.text - formatted text for Slack
 * @param {string} [params.webhookEnvKey] - optional env var key to read webhook from first
 * @param {object} [params.meta] - additional context: deliveryId, customerId, customerName, bagIds, userId
 * @param {object} [params.payload] - full payload sent to Slack
 * @param {boolean} [params.preferWebhook] - use a configured webhook before the bot API
 * @returns {Promise<{ok:boolean,status?:number,error?:string}>}
 */
export async function sendAndLogSlack({ type, text, webhookEnvKey, meta = {}, payload, channelId, preferWebhook = false }) {
  const notificationsDisabled = process.env.ENABLE_SLACK_NOTIFICATIONS === '0';

  // Resolve webhook URL with fallbacks similar to existing code
  const resolvedWebhook =
    (webhookEnvKey && process.env[webhookEnvKey]) ||
    process.env.SLACK_WEBHOOK_URL ||
    process.env.SLACK_LOCATION_CHANGE_WEBHOOK_URL ||
    process.env.SLACK_REMOVAL_WEBHOOK ||
    process.env.SLACK_BAG_COLLECTION_WEBHOOK_URL ||
    process.env.SLACK_BAG_COLLECTION_WEBHOOK ||
    process.env.SLACK_MANUAL_ENTRY_WEBHOOK_URL;

  const slackPayload = payload || { text };
  const botToken = process.env.SLACK_BOT_TOKEN;
  // Derive channel env var from webhook key, or use provided channelId
  let resolvedChannelId = channelId;
  if (!resolvedChannelId && webhookEnvKey) {
    const channelEnvKey = webhookEnvKey.replace('WEBHOOK_URL', 'CHANNEL_ID');
    resolvedChannelId = process.env[channelEnvKey];
  }
  if (!resolvedChannelId) {
    resolvedChannelId = process.env.SLACK_DEFAULT_CHANNEL_ID;
  }

  // If disabled or no webhook, skip send but still log intent for audit
  let responseStatus;
  let responseError;
  let usedChannel;
  let usedTs;
  if (notificationsDisabled) {
    responseStatus = 0;
    responseError = 'Slack notifications disabled';
  } else if (botToken && resolvedChannelId && !(preferWebhook && resolvedWebhook)) {
    // Prefer Slack Web API to enable future edits
    try {
      const resp = await axios.post('https://slack.com/api/chat.postMessage', {
        channel: resolvedChannelId,
        text: slackPayload.text,
        blocks: slackPayload.blocks,
        attachments: slackPayload.attachments
      }, {
        headers: { Authorization: `Bearer ${botToken}` },
        timeout: 8000
      });
      responseStatus = resp.status;
      if (resp.data?.ok) {
        usedChannel = resp.data.channel;
        usedTs = resp.data.ts;
      } else {
        responseError = resp.data?.error || 'Slack API error';
      }
    } catch (err) {
      responseStatus = err.response?.status || 0;
      responseError = err.message;
    }
  } else if (resolvedWebhook) {
    // Fallback to webhook
    try {
      const resp = await axios.post(resolvedWebhook, slackPayload, { timeout: 8000 });
      responseStatus = resp.status;
    } catch (err) {
      responseStatus = err.response?.status || 0;
      responseError = err.message;
    }
  } else {
    responseStatus = 0;
    responseError = 'Slack webhook/channel not configured';
  }

  try {
    await SlackLog.create({
      type,
      text,
      payload: slackPayload,
      webhookUrl: resolvedWebhook,
      channel: usedChannel || resolvedChannelId,
      ts: usedTs,
      responseStatus,
      responseError,
      deliveryId: meta.deliveryId,
      partnerId: meta.partnerId,
      partnerOrderId: meta.partnerOrderId,
      communicationId: meta.communicationId,
      customerId: meta.customerId,
      customerName: meta.customerName,
      bagIds: Array.isArray(meta.bagIds) ? meta.bagIds : undefined,
      userId: meta.userId,
    });
  } catch (e) {
    // Don't crash on log failure
    console.warn('Failed to log Slack message:', e?.message || e);
  }

  return { ok: !responseError, status: responseStatus, error: responseError, channel: usedChannel || resolvedChannelId, ts: usedTs };
}

export async function updateSlackMessage({ channel, ts, text, payload }) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken || !channel || !ts) {
    return { ok: false, error: 'Missing bot token/channel/ts' };
  }
  try {
    const resp = await axios.post('https://slack.com/api/chat.update', {
      channel,
      ts,
      text,
      blocks: payload?.blocks,
      attachments: payload?.attachments
    }, {
      headers: { Authorization: `Bearer ${botToken}` },
      timeout: 8000
    });
    if (resp.data?.ok) return { ok: true };
    return { ok: false, error: resp.data?.error || 'Slack API error' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
