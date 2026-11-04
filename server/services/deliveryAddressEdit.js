import { isDeepStrictEqual } from 'node:util';

const owns = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const text = (value) => String(value ?? '').trim();
const plain = (value) => value?.toObject ? value.toObject() : value;
const same = (a, b) => isDeepStrictEqual(plain(a) ?? null, plain(b) ?? null);

// A new destination must not retain the previous destination's breakdown,
// identity or numeric pin. Forms may resend unchanged nested objects.
export function sanitizeDeliveryAddressEdit(original, fields) {
  if (!owns(fields, 'address') || text(fields.address) === text(original?.address)) return fields;
  for (const parent of ['addressDetails', 'gpsLocation']) {
    const dotted = Object.keys(fields).filter((key) => key.startsWith(`${parent}.`));
    if (dotted.length) {
      fields[parent] = { ...(plain(fields[parent]) || {}) };
      for (const key of dotted) {
        fields[parent][key.slice(parent.length + 1)] = fields[key];
        delete fields[key];
      }
    }
  }
  if (!owns(fields, 'addressId') || text(fields.addressId) === text(original?.addressId)) fields.addressId = null;
  if (!owns(fields, 'addressDetails') || same(fields.addressDetails, original?.addressDetails)) {
    for (const key of Object.keys(fields)) if (key.startsWith('addressDetails.')) delete fields[key];
    fields.addressDetails = null;
  }

  const pin = plain(fields.gpsLocation);
  const oldPin = plain(original?.gpsLocation);
  const newCoordinates = typeof pin?.lat === 'number' && typeof pin?.lng === 'number'
    && Number.isFinite(pin.lat) && Number.isFinite(pin.lng)
    && Math.abs(pin.lat) <= 90 && Math.abs(pin.lng) <= 180
    && (pin.lat !== oldPin?.lat || pin.lng !== oldPin?.lng);
  if (!newCoordinates) {
    // Keep a newly supplied Maps link, but never treat it as verified coordinates.
    const link = text(pin?.link) && pin.link !== oldPin?.link ? pin.link : undefined;
    for (const key of Object.keys(fields)) if (key.startsWith('gpsLocation.')) delete fields[key];
    fields.gpsLocation = link ? { link } : null;
  }
  return fields;
}

