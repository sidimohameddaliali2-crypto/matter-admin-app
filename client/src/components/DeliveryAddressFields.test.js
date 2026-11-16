import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DeliveryAddressFields from './DeliveryAddressFields';
import DeliveryAddressDetails from './driver/DeliveryAddressDetails';

test.each(['villa', 'apartment', 'office'])('%s form displays the matching required address fields', category => {
  const html = renderToStaticMarkup(<DeliveryAddressFields value={{ category }} onChange={() => {}} />);
  for (const label of ['Delivery Zone', 'Street', 'Pin Location', 'Additional Details']) expect(html).toContain(label);
  expect(html).toContain(category === 'villa' ? 'Villa Number' : 'Apartment Number');
  expect(html.includes('Building Name')).toBe(category !== 'villa');
  expect(html.includes('>Floor')).toBe(category !== 'villa');
  expect(html).toContain('name="delivery-address-category"');
});

test('driver renders Matter API names and existing imported address aliases identically', () => {
  const base = { zone: 'Test Zone', gpsLocation: { lat: 25.1, lng: 55.2 } };
  const canonical = renderToStaticMarkup(<DeliveryAddressDetails delivery={{ ...base, addressDetails: {
    category: 'office', street: 'Test Street', building: 'Test Tower', floor: '2', unit: '03', additional_details: 'Side door'
  } }} />);
  const legacy = renderToStaticMarkup(<DeliveryAddressDetails delivery={{ ...base, addressDetails: {
    sourceCategory: 'office', street: 'Test Street', building: 'Test Tower', floor: '2', apartment: '03', additionalDetails: 'Side door'
  } }} />);
  expect(canonical).toBe(legacy);
  for (const value of ['Office', 'Test Tower', 'Side door', '25.1, 55.2', 'Apartment Number']) expect(canonical).toContain(value);
});

test('villa instructions remain visible on the driver page', () => {
  const html = renderToStaticMarkup(<DeliveryAddressDetails delivery={{ addressDetails: {
    category: 'villa', unit: '17', street: 'Street 2', additional_details: 'Ring the bell'
  } }} />);
  expect(html).toContain('Villa Number');
  expect(html).toContain('Ring the bell');
  expect(html).not.toContain('Apartment Number');
});
