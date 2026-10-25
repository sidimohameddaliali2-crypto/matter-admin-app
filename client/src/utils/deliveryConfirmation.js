export function requireDeliveryConfirmation(data, deliveryId, status) {
  const delivery = data?.delivery;
  if (data?.success !== true || !delivery || String(delivery._id) !== String(deliveryId) || delivery.status !== status) {
    throw new Error((data?.success !== true && data?.message) || 'The server has not confirmed this delivery. Keep the photo and retry sync.');
  }
  return delivery;
}
