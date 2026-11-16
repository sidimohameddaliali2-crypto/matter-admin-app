import React from 'react';

export default function DeliveryAddressDetails({ delivery }) {
  const d = delivery.addressDetails;
  if (!d) return null;
  const category = String(d.category || d.sourceCategory || d.locationType || '').toLowerCase();
  const pin = delivery.gpsLocation;
  const rows = [
    ['Category', category ? category[0].toUpperCase() + category.slice(1) : null],
    ['Delivery Zone', delivery.zone || d.area],
    ['Street', d.street],
    ...(category === 'villa'
      ? [['Villa Number', d.unit || d.apartment || d.building]]
      : [['Building Name', d.building], ['Floor', d.floor], ['Apartment Number', d.unit || d.apartment]]),
    ['Pin Location', Number.isFinite(pin?.lat) && Number.isFinite(pin?.lng) ? `${pin.lat}, ${pin.lng}` : null],
    ['Additional Details', d.additional_details || d.additionalDetails]
  ].filter(([, value]) => value != null && value !== '');
  if (!rows.length) return null;
  return <dl className="text-sm space-y-1 mb-3 break-words" aria-label="Delivery address details">
    {rows.map(([label, value]) => <div key={label}><dt className="inline font-semibold">{label}: </dt><dd className="inline">{value}</dd></div>)}
  </dl>;
}
