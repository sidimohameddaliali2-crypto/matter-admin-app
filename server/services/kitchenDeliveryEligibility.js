import Record from '../models/MenuSelectionRecord.js';

export const kitchenDateUnavailable = async (record, date, nutrition) => {
  const skip = (record?.skippedDays || []).find(day => String(day.date).slice(0, 10) === date && !day.resumedAt);
  const dates = nutrition?.active_delivery_dates;
  if (!Array.isArray(dates)) return !!skip;
  if (!dates.includes(date)) return true;
  if (skip?.pauseStatus === 'pending') return true;
  if (skip && record?._id) {
    const resumedAt = new Date();
    const result = await Record.updateOne({ _id: record._id, skippedDays: { $elemMatch: { date, resumedAt: { $exists: false }, pauseStatus: { $ne: 'pending' } } } }, {
      $set: { 'skippedDays.$.resumedAt': resumedAt },
      $push: { kitchenAudit: { date, action: 'delivery-resumed', at: resumedAt, subscriptionId: String(nutrition.subscription_id), reason: 'Fresh Matter schedule confirms active delivery' } },
    });
    if (!result.modifiedCount) throw Object.assign(new Error('Delivery pause changed during preparation. Retry this date.'), { statusCode: 409, code: 'KITCHEN_PREPARATION_BUSY' });
    skip.resumedAt = resumedAt;
  }
  return false;
};
