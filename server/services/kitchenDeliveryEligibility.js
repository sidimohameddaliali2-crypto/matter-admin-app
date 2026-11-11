import Record from '../models/MenuSelectionRecord.js';

// A pending or failed pause request is not proof the day is paused. Confirmed
// outcomes (success, already_paused, declined, or a legacy skip with no
// status) still block preparation when there is no fresh calendar.
const UNRESOLVED_PAUSE = new Set(['pending', 'failed']);

export const kitchenDateUnavailable = async (record, date, nutrition) => {
  const skip = (record?.skippedDays || []).find(day => String(day.date).slice(0, 10) === date && !day.resumedAt);
  const dates = nutrition?.active_delivery_dates;
  if (!Array.isArray(dates)) return !!skip && !UNRESOLVED_PAUSE.has(skip?.pauseStatus);
  if (!dates.includes(date)) return true;
  // The website still lists this day as active. Do not suppress preparation,
  // and do not rewrite an unresolved request as a resume.
  if (UNRESOLVED_PAUSE.has(skip?.pauseStatus)) return false;
  if (skip && record?._id) {
    const resumedAt = new Date();
    const result = await Record.updateOne({ _id: record._id, skippedDays: { $elemMatch: { date, resumedAt: { $exists: false }, pauseStatus: { $nin: ['pending', 'failed'] } } } }, {
      $set: { 'skippedDays.$.resumedAt': resumedAt },
      $push: { kitchenAudit: { date, action: 'delivery-resumed', at: resumedAt, subscriptionId: String(nutrition.subscription_id), reason: 'Fresh Matter schedule confirms active delivery' } },
    });
    if (!result.modifiedCount) throw Object.assign(new Error('Delivery pause changed during preparation. Retry this date.'), { statusCode: 409, code: 'KITCHEN_PREPARATION_BUSY' });
    skip.resumedAt = resumedAt;
  }
  return false;
};
