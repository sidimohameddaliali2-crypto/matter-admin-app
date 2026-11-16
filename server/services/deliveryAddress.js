// Manual deliveries use Matter's customer_addresses field names. Retain the
// existing aliases for maps, exports and older driver clients.
export function structuredDeliveryAddress(details) {
  if (!details?.category) return null;
  const category = String(details.category).trim().toLowerCase();
  const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!['villa', 'apartment', 'office'].includes(category)) fail('Choose Villa, Apartment or Office.');
  const clean = key => String(details[key] ?? '').trim();
  for (const key of ['area', 'street', 'unit', ...(category === 'villa' ? [] : ['building', 'floor'])]) {
    if (!clean(key)) fail(`Address field ${key} is required.`);
  }
  const pin = details.coordinates;
  const validNumber = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value));
  if (!validNumber(pin?.lat) || !validNumber(pin?.lng) || Math.abs(Number(pin.lat)) > 90 || Math.abs(Number(pin.lng)) > 180
    || (Number(pin.lat) === 0 && Number(pin.lng) === 0)) fail('A valid pin latitude and longitude are required.');
  const coordinates = { lat: Number(pin.lat), lng: Number(pin.lng) };
  const addressDetails = {
    category, sourceCategory: category,
    area: clean('area'), street: clean('street'),
    building: category === 'villa' ? '' : clean('building'),
    floor: category === 'villa' ? '' : clean('floor'),
    unit: clean('unit'), apartment: clean('unit'),
    additional_details: clean('additional_details'), additionalDetails: clean('additional_details'),
    coordinates, locationType: category === 'office' ? null : category === 'villa' ? 'Villa' : 'Apartment'
  };
  const address = [category === 'villa' ? `Villa ${addressDetails.unit}` : addressDetails.building,
    category !== 'villa' ? `Unit ${addressDetails.unit}` : null,
    addressDetails.floor ? `Floor ${addressDetails.floor}` : null, addressDetails.street, addressDetails.area].filter(Boolean).join(', ');
  return { addressDetails, address, zone: addressDetails.area, gpsLocation: coordinates };
}
