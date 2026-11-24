export const DEFAULT_PARTNER_WINDOWS = ['Morning · 5–6am', 'Morning · 7–10am'];
export const PARTNER_BUSINESS_FIELDS = ['invoiceBusinessName', 'deliveryAddress', 'deliveryRecipientPhone', 'websiteUrl', 'instagramUrl'];
export const partnerDeliveryWindows = partner => partner?.deliveryTimeSlots?.length ? partner.deliveryTimeSlots : DEFAULT_PARTNER_WINDOWS;
export const partnerInvoiceName = partner => partner?.invoiceBusinessName?.trim() || partner?.businessName || '';
export function assertPartnerDelivery(partner, date, window) {
  const weekday = new Date(date).getUTCDay();
  if (weekday === 0 || (partner?.weekendsDisabled && weekday === 6)) {
    throw Object.assign(new Error(partner?.weekendsDisabled ? 'Weekend deliveries are disabled for your account.' : 'There is no delivery on Sunday — pick another date.'), {status: 400});
  }
  if (window != null && !partnerDeliveryWindows(partner).includes(window)) {
    throw Object.assign(new Error('Choose one of your available delivery times.'), {status: 400});
  }
}
export function partnerProfileData(partner) {
  return Object.fromEntries(['businessName', 'minimumOrder', 'weekendsDisabled', 'deliveryTimeSlots', 'defaultDeliveryTime', ...PARTNER_BUSINESS_FIELDS].map(key => [key, partner[key]]));
}
export function validPartnerUrl(value, instagram = false) {
  if (!value) return true;
  try {const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && (!instagram || ['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()));}
  catch {return false;}
}
