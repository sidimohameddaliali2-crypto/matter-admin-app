export const DEFAULT_PARTNER_WINDOWS = ['Morning · 5–6am', 'Morning · 7–10am'];
export const PARTNER_BUSINESS_FIELDS = [
  ['invoiceBusinessName', 'Invoice business name', 'text', 'Leave blank to use the partner name'],
  ['deliveryAddress', 'Delivery address', 'text', 'Address for meal deliveries'],
  ['deliveryRecipientPhone', 'Delivery recipient phone', 'tel', '+971 50 000 0000'],
  ['websiteUrl', 'Website (optional)', 'url', 'https://example.com'],
  ['instagramUrl', 'Instagram (optional)', 'url', 'https://www.instagram.com/yourbusiness']
];
export const partnerDeliveryWindows = partner => partner?.deliveryTimeSlots?.length ? partner.deliveryTimeSlots : DEFAULT_PARTNER_WINDOWS;
export const partnerDefaultWindow = partner => partnerDeliveryWindows(partner).includes(partner?.defaultDeliveryTime) ? partner.defaultDeliveryTime : partnerDeliveryWindows(partner)[0];
export const partnerDateAllowed = (date, partner) => {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return day !== 0 && !(partner?.weekendsDisabled && day === 6);
};
export function assertPartnerPlanDelivery(day, partner) {
  if (day.placed || day.skipped) return;
  if (!partnerDateAllowed(day.date, partner)) throw new Error(day.date + ': deliveries are disabled for this day. Remove this day from your plan.');
  if (!partnerDeliveryWindows(partner).includes(day.window)) throw new Error(day.date + ': choose an available delivery time.');
}
