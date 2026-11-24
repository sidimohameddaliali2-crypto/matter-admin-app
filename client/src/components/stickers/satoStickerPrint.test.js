import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import SatoStickerPrintModal from './SatoStickerPrintModal';
import {
  buildSatoPrintMarkup, expandSatoDeliveries, fitSatoLabels, loadSatoAlignment, sortSatoDeliveries, SATO_ALIGNMENT_KEY,
} from './satoStickerPrint';

global.IS_REACT_ACT_ENVIRONMENT = true;
const delivery = {
  _id: 'delivery-1', customerName: 'Alex <Morgan>', address: 'Apartment 12\nDubai Marina',
  zone: 'Dubai Marina', scheduledTime: '2026-11-28T03:00:00Z',
  driver: { _id: 'driver-1', profile: { firstName: 'Jamie', lastName: 'Taylor' } },
};

beforeEach(() => localStorage.clear());

test('prints real delivery data with black vector logo and no demo text', () => {
  const html = buildSatoPrintMarkup([delivery], { x: 1, y: -1 });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  expect(doc.querySelectorAll('.sato-label')).toHaveLength(1);
  expect(doc.querySelector('.sato-logo svg g').getAttribute('fill')).toBe('#000000');
  expect(doc.body.textContent).toContain('Alex <Morgan>');
  expect(doc.querySelector('.sato-address').textContent).toContain(delivery.address);
  expect(doc.querySelector('.sato-zone').textContent).toContain(delivery.zone);
  expect(doc.querySelector('.sato-timing').textContent).toContain('07:00 AM');
  expect(doc.body.textContent).not.toMatch(/driver|Jamie Taylor/i);
  expect(doc.body.textContent).not.toMatch(/demo|sample|test label/i);
  expect(doc.querySelector('script')).toBeNull();
  expect(html).toContain('size: 60mm 80mm');
  expect(html).toContain('--sato-x: 1mm; --sato-y: -1mm');
});

test('weekend deliveries get separate Saturday and Sunday labels with real dates', () => {
  const expanded = expandSatoDeliveries([{ ...delivery, combinedSunday: { deliveryId: 'sunday-id', scheduledTime: '2026-11-29T03:00:00Z' } }]);
  expect(expanded).toHaveLength(2);
  expect(expanded[1]._id).toBe('sunday-id');
  const doc = new DOMParser().parseFromString(buildSatoPrintMarkup(expanded, {}), 'text/html');
  expect(doc.querySelectorAll('.sato-label')).toHaveLength(2);
  expect(doc.body.textContent).toContain('28/11/2026');
  expect(doc.body.textContent).toContain('29/11/2026');
});

test('timing uses UAE time across midnight and handles missing/invalid schedules', () => {
  const doc = new DOMParser().parseFromString(buildSatoPrintMarkup([
    { ...delivery, scheduledTime: '2026-11-28T21:30:00Z' },
    { ...delivery, scheduledTime: null }, { ...delivery, scheduledTime: 'invalid' },
  ], {}), 'text/html');
  const times = doc.querySelectorAll('.sato-timing');
  expect(times[0].textContent).toContain('01:30 AM');
  expect(doc.querySelector('.sato-date').textContent).toBe('29/11/2026');
  expect(times[1].textContent).toContain('Not scheduled');
  expect(times[2].textContent).toContain('Not scheduled');
});

test('prints Abu Dhabi first using emirate and zone rules, preserving order within groups', () => {
  const input = [
    { ...delivery, _id: 'dubai-1' },
    { ...delivery, _id: 'abu-city', zone: 'Al Reem', addressDetails: { city: 'ABU DHABI - Al Reem Island' } },
    { ...delivery, _id: 'dubai-2' },
    { ...delivery, _id: 'abu-zone', zone: ' abu dhabi - Al Dana' },
    { ...delivery, _id: 'dubai-south', zone: 'Dubai South' },
  ];
  const sorted = sortSatoDeliveries(input);
  expect(sorted.map((item) => item._id)).toEqual(['abu-city', 'abu-zone', 'dubai-south', 'dubai-1', 'dubai-2']);
  expect(input[0]._id).toBe('dubai-1');
  const named = input.map((item) => ({ ...item, customerName: item._id }));
  const doc = new DOMParser().parseFromString(buildSatoPrintMarkup(named, {}), 'text/html');
  expect(Array.from(doc.querySelectorAll('h1')).map((item) => item.textContent)).toEqual(sorted.map((item) => item._id));
});

test('alignment restores existing settings and clamps invalid or excessive offsets', () => {
  localStorage.setItem(SATO_ALIGNMENT_KEY, '{"x":100,"y":"bad"}');
  expect(loadSatoAlignment()).toEqual({ x: 3, y: 0 });
  localStorage.setItem(SATO_ALIGNMENT_KEY, 'null');
  expect(loadSatoAlignment()).toEqual({ x: 0, y: 0 });
});

test('text too large for a readable label is refused rather than silently clipped', () => {
  const layout = { style: {}, scrollHeight: 400, clientHeight: 200, scrollWidth: 100, clientWidth: 100 };
  expect(fitSatoLabels({ querySelectorAll: () => [layout] })).toBe(false);
  expect(layout.style.fontSize).toBe('7pt');
  layout.scrollHeight = 150;
  expect(fitSatoLabels({ querySelectorAll: () => [layout] })).toBe(true);
  expect(layout.style.fontSize).toBe('9pt');
});

test('modal previews delivery data, persists adjustments, and reports blocked popups', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const open = jest.spyOn(window, 'open').mockReturnValue(null);
  try {
    await act(async () => root.render(<SatoStickerPrintModal deliveries={[delivery]} onClose={() => {}} />));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('.sato-customer').textContent).toContain(delivery.customerName);
    expect(container.querySelector('[placeholder="Driver code"]')).toBeNull();
    const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Print 1 sticker');
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]').textContent).toContain('Allow pop-ups');
    expect(JSON.parse(localStorage.getItem(SATO_ALIGNMENT_KEY))).toEqual({ x: 0, y: 0 });
  } finally {
    await act(async () => root.unmount()); container.remove(); open.mockRestore();
  }
});

test('batch print sends every delivery while one-label printing sends only the chosen preview', async () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  let printedMarkup = '';
  const popup = { document: { write: jest.fn((html) => { printedMarkup = html; }), close: jest.fn(), querySelectorAll: () => [] }, focus: jest.fn(), print: jest.fn() };
  const open = jest.spyOn(window, 'open').mockReturnValue(popup);
  try {
    await act(async () => root.render(<SatoStickerPrintModal deliveries={[delivery, { ...delivery, _id: 'second', customerName: 'Second customer' }]} onClose={() => {}} />));
    await act(async () => Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Print 2 stickers').click());
    expect(new DOMParser().parseFromString(printedMarkup, 'text/html').querySelectorAll('.sato-label')).toHaveLength(2);
    popup.onload();
    expect(popup.print).toHaveBeenCalledTimes(1);
    const select = container.querySelector('select');
    await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Print one label').click());
    const doc = new DOMParser().parseFromString(printedMarkup, 'text/html');
    expect(doc.querySelectorAll('.sato-label')).toHaveLength(1);
    expect(doc.body.textContent).toContain('Second customer');
    expect(doc.body.textContent).not.toContain('Alex');
  } finally {
    await act(async () => root.unmount()); container.remove(); open.mockRestore();
  }
});
