export const collectionRefundFilter = () => ({ type: 'Collection', status: { $in: ['collected', 'completed', 'delivered'] }, 'collectionRequest.refundRequestedAfterCollection': true, 'collectionDetails.noBagsAvailable': { $ne: true } });
export function collectionRefundQueueFilter(status, paid) {
  const filter = collectionRefundFilter();
  if (status === 'refunded') filter.customerId = { $in: paid };
  else if (['pending', 'not_refunded'].includes(status)) {
    filter.customerId = { $nin: paid };
    // Pending includes earlier Not refunded updates so no unpaid request disappears.
    filter['collectionRefund.status'] = status === 'pending' ? { $ne: 'refunded' } : 'not_refunded';
  }
  return filter;
}
export const canRecordCollectionRefund = user => ['super_admin', 'admin', 'manager'].includes(user?.role);
export const refundError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export function buildCollectionRefundUpdate(record, input, user, now = new Date()) {
  if (!canRecordCollectionRefund(user)) throw refundError('Management access is required to update refunds.', 403);
  if (record.type !== 'Collection' || !['collected', 'completed', 'delivered'].includes(record.status) || !record.collectionRequest?.refundRequestedAfterCollection || record.collectionDetails?.noBagsAvailable) throw refundError('A completed bag collection with a refund request is required.', 409);
  if (!['refunded', 'not_refunded'].includes(input.status)) throw refundError('Choose Refunded or Not refunded.');
  if (typeof input.eventId !== 'string' || !/^[a-zA-Z0-9:_-]{8,180}$/.test(input.eventId)) throw refundError('A valid update ID is required.');
  if (!Number.isInteger(input.version) || input.version !== (record.collectionRefund?.version || 0)) throw refundError('This refund changed. Refresh before updating it.', 409);
  if (record.collectionRefund?.status === 'refunded') throw refundError('This refund is already recorded as refunded.', 409);
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  if (!note || note.length > 2000 || reference.length > 200) throw refundError('Enter an update note (maximum 2,000 characters).');
  if (input.status === 'refunded' && !reference) throw refundError('Enter the refund payment reference.');
  if (input.status === 'refunded' && !['card', 'bank_account'].includes(input.method)) throw refundError('Choose credit/debit card or bank account for this refund.');
  const actorName = [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ') || user.email || 'Staff';
  const set = { 'collectionRefund.status': input.status, 'collectionRefund.note': note, 'collectionRefund.reference': reference, 'collectionRefund.updatedAt': now, 'collectionRefund.updatedBy': user._id, 'collectionRefund.updatedByName': actorName };
  if (input.status === 'refunded') { set['collectionRefund.depositKey'] = record.customerId; set['collectionRefund.method'] = input.method; }
  return { $set: set, $inc: { 'collectionRefund.version': 1 }, $push: { 'collectionRefund.history': { eventId: input.eventId, status: input.status, reference, method: input.status === 'refunded' ? input.method : undefined, note, actor: user._id, actorName, timestamp: now } } };
}
