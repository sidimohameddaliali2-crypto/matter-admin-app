import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { recordActivityChange } from '../utils/activityCapture';
import api from '../utils/api';
import partnerApi from '../utils/partnerApi';
import IngredientTagEditor from './IngredientTagEditor';
import ComponentExclusions from '../pages/adminMealSelectionV2/ComponentExclusions';
import WeeklyCycleBoard from '../pages/adminMealSelectionV2/WeeklyCycleBoard';
import LocationPinPicker from './LocationPinPicker';
import ManualOrderModal from './ManualOrderModal';
import RouteOptimizationModal from './RouteOptimizationModal';
import PartnerDailyOrderPlanner from './PartnerDailyOrderPlanner';
import SupyRecipeSearch from './SupyRecipeSearch';
import DeliveryOrderModal from './DeliveryOrderModal';
import AddDeliveryChange from '../pages/AddDeliveryChange';
import UserPermissionsModal from './users/UserPermissionsModal';
import { MealComposer } from '../pages/adminMealSelectionV2/WorkbookMealPages';
import StickerDesignerModal from './stickers/StickerDesignerModal';
import PrintConfigModal from './deliveries/PrintConfigModal';
import BagTagPrintModal from './BagTagPrintModal';
import CreateEventModal from './events/CreateEventModal';
import EventDetailModal from './events/EventDetailModal';
import AddDelivery from '../pages/AddDelivery';
import WebsiteSubscription from '../pages/WebsiteSubscription';
import AdminPartners from '../pages/AdminPartners';

jest.mock('../utils/activityCapture', () => ({ recordActivityChange: jest.fn() }));
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));
jest.mock('../utils/partnerApi', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('react-router-dom', () => ({ Link: ({ children }) => <span>{children}</span>, useNavigate: () => jest.fn(), useParams: () => ({ id: 'subscription' }) }), { virtual: true });
jest.mock('qrcode.react', () => ({ QRCodeCanvas: () => null }));
const mockEvent = { _id: 'event', status: 'pending', eventName: 'Fixture event', companyName: 'Matter', eventDate: '2099-01-05', logistics: { food: [{ name: 'Rice', quantity: 2 }] }, venue: {}, pointOfContact: {}, disassembly: {} };
jest.mock('react-redux', () => ({ useDispatch: () => jest.fn(), useSelector: fn => fn({ auth: { user: { role: 'super_admin' } }, user: { isLoading: false }, events: { isLoading: false, selectedEvent: mockEvent } }) }));
jest.mock('jspdf', () => jest.fn());
jest.mock('html2canvas', () => jest.fn());
jest.mock('react-day-picker', () => ({ DayPicker: ({ mode, onSelect }) => <button type="button" onClick={() => onSelect(mode === 'range' ? { from: new Date(2099, 0, 5), to: new Date(2099, 0, 6) } : [new Date(2099, 0, 5)])}>Pick {mode}</button> }));
jest.mock('react-day-picker/dist/style.css', () => ({}), { virtual: true });
jest.mock('@2gis/mapgl', () => ({ load: () => new Promise(() => {}) }));
process.env.REACT_APP_2GIS_API_KEY = 'fixture-map-key';
const DriverRouteMap2GIS = require('./DriverRouteMap2GIS').default;
let mockMapEvents, mockMarkerEvents;
jest.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: ({ eventHandlers }) => { mockMarkerEvents = eventHandlers; return null; },
  useMapEvents: events => { mockMapEvents = events; }
}));

let host, root;
const render = node => act(async () => root.render(node));
const button = label => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.title === label);
const click = label => act(async () => button(label).click());
const input = (node, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
});
const changes = () => recordActivityChange.mock.calls.map(([change]) => change);
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  localStorage.clear();
  window.fetch = jest.fn().mockResolvedValue({ ok: false });
  api.get.mockResolvedValue({ data: { data: [{ id: 'recipe', name: 'Roast chicken', ingredients: [] }] } });
  api.post.mockResolvedValue({ data: { data: {} } });
  api.put.mockResolvedValue({ data: { success: true } });
  partnerApi.get.mockImplementation(async path => ({ data: { success: true, data: path === '/partner/orders' ? [] : [{ _id: 'meal', name: 'Roast chicken', price: 20 }] } }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); jest.useRealTimers(); });

test('ingredient visibility and removal are observed before any save, with readable values', async () => {
  function Editor() { const [tags, setTags] = useState([{ name: 'Salt', visible: true }]); return <IngredientTagEditor value={tags} onChange={setTags}/>; }
  await render(<Editor/>);
  await click('Salt');
  expect(changes()).toEqual([expect.objectContaining({ before: ['Salt (shown to customer)'], after: ['Salt (backend only)'] })]);
  await click('Remove ingredient');
  expect(changes()[1]).toMatchObject({ before: ['Salt (backend only)'], after: [] });
});

test('committing ingredient tags records final tags rather than only the typed draft', async () => {
  await render(<IngredientTagEditor value={[]} onChange={jest.fn()}/>);
  input(host.querySelector('input'), 'Salt, Pepper');
  expect(changes()[0]).toMatchObject({ before: [], after: ['Salt (shown to customer)'] });
});

test('removing a component exclusion observes the unsaved change', async () => {
  await render(<ComponentExclusions values={['Nuts', 'Dairy']} onChange={jest.fn()} componentName="Chicken"/>);
  await click('Remove exclusion Nuts');
  expect(changes()[0]).toMatchObject({ before: ['Nuts', 'Dairy'], after: ['Dairy'] });
});

test('map click and marker drag record coordinates without turning the default marker into an old saved pin', async () => {
  await render(<LocationPinPicker onChange={jest.fn()}/>);
  act(() => mockMapEvents.click({ latlng: { lat: 25.1, lng: 55.2 } }));
  expect(changes()[0]).toMatchObject({ before: 'Not set', after: '25.100000, 55.200000' });
  await render(<LocationPinPicker lat={25.1} lng={55.2} onChange={jest.fn()}/>);
  act(() => mockMarkerEvents.dragend({ target: { getLatLng: () => ({ lat: 25.2, lng: 55.3 }) } }));
  expect(changes()[1]).toMatchObject({ before: '25.100000, 55.200000', after: '25.200000, 55.300000' });
});

test('manual order arrows observe unsaved ordering with stop names, and cancel performs no write', async () => {
  const close = jest.fn();
  await render(<ManualOrderModal open onClose={close} deliveries={[{ _id: 'a', customerName: 'Aster', driver: { _id: 'driver' }, routeOrder: 0 }, { _id: 'b', customerName: 'Birch', driver: { _id: 'driver' }, routeOrder: 1 }]} drivers={[{ _id: 'driver', name: 'Driver' }]}/>);
  act(() => host.querySelector('button[title="Move later"]').click());
  expect(changes()[0]).toMatchObject({ before: ['Aster', 'Birch'], after: ['Birch', 'Aster'] });
  await click('Close'); expect(close).toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

test('rapid manual order moves preserve both changes and distinct unnamed stops', async () => {
  await render(<ManualOrderModal open onClose={jest.fn()} deliveries={['a', 'b', 'c'].map((id, routeOrder) => ({ _id: id, driver: { _id: 'driver' }, routeOrder }))} drivers={[{ _id: 'driver', name: 'Driver' }]}/>);
  const earlier = host.querySelectorAll('button[title="Move earlier"]')[2];
  act(() => { earlier.click(); earlier.click(); });
  expect([...host.querySelectorAll('li input')].map(node => node.value)).toEqual(['1', '2', '3']);
  expect(changes()).toHaveLength(2);
  expect(changes()[1].before).toEqual(changes()[0].after);
  expect(changes()[1].after[0]).toContain('c');
});

test('weekly placement and removal record readable board changes even if persistence fails', async () => {
  const onSaveBoards = jest.fn().mockRejectedValue(new Error('Offline'));
  await render(<WeeklyCycleBoard initialBoards={{}} meals={[{ id: 'meal', name: 'Roast chicken', mealKind: 'Main meal', components: [] }]} onSaveBoards={onSaveBoards}/>);
  act(() => host.querySelector('.av2-library-card').click()); await click('Add to draft');
  expect(changes()[0]).toMatchObject({ before: [], after: ['Roast chicken'] });
  expect(host.textContent).toContain('Offline');
  await click('Remove meal from Monday');
  expect(changes()[1]).toMatchObject({ before: ['Roast chicken'], after: [] });
});

test('dragging a selected van into hub vans records a proposal before generation', async () => {
  await render(<RouteOptimizationModal open deliveries={[]} drivers={[{ _id: 'van', profile: { firstName: 'Aster', vehicleType: 'van' } }]} initialSelectedDriverIds={['van']}/>);
  const drop = new Event('drop', { bubbles: true }); Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'van' } });
  act(() => host.querySelector('.border-dashed').dispatchEvent(drop));
  expect(changes()[0]).toMatchObject({ before: [], after: ['Aster'] });
  act(() => host.querySelector('.border-dashed').dispatchEvent(drop));
  expect(recordActivityChange).toHaveBeenCalledTimes(1); expect(api.post).not.toHaveBeenCalled();
});

test('partner date, meal quantity and delivery window changes are observed without placing an order', async () => {
  await render(<PartnerDailyOrderPlanner partner={{ _id: 'partner', minimumOrder: 0 }} earliestDate="2099-01-05" orders={[]}/>);
  await click('Delivery 2099-01-06');
  expect(changes().some(change => change.field === 'Delivery dates')).toBe(true);
  await click('Start daily orders'); await click('Add Roast chicken');
  expect(changes().some(change => change.before === 0 && change.after === 1 && change.field.includes('Roast chicken'))).toBe(true);
  const windowButton = [...host.querySelectorAll('[aria-label="Delivery window"] button')].find(node => node.getAttribute('aria-pressed') === 'false');
  act(() => windowButton.click());
  expect(changes().some(change => change.field.includes('Delivery window'))).toBe(true);
  expect(partnerApi.post).not.toHaveBeenCalled();
});

test('recipe selection observes the chosen result after search, without claiming a save', async () => {
  jest.useFakeTimers();
  await render(<SupyRecipeSearch value="Old recipe" onSelect={jest.fn()}/>);
  input(host.querySelector('input'), 'Roast');
  await act(async () => { jest.advanceTimersByTime(300); }); await click('Roast chicken');
  expect(changes()[0]).toMatchObject({ before: 'Old recipe', after: 'Roast chicken' });
  expect(api.post).not.toHaveBeenCalled();
});

test('delivery order arrows capture the old and new draft before saving', async () => {
  api.get.mockResolvedValue({ data: { data: { deliveries: [{ _id: 'a', customerName: 'Aster' }, { _id: 'b', customerName: 'Birch' }], revision: 'revision' } } });
  await render(<DeliveryOrderModal date="2099-01-05" drivers={[{ _id: 'driver', name: 'Driver' }]} onClose={jest.fn()}/>);
  await act(async () => { const select = host.querySelector('select'); select.value = 'driver'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('Move stop 2 up');
  expect(changes()[0]).toMatchObject({ before: ['Aster', 'Birch'], after: ['Birch', 'Aster'] });
  expect(api.post).not.toHaveBeenCalled();
});

test('delivery order rapid moves retain the functional update behavior and distinguish unnamed stops', async () => {
  api.get.mockResolvedValue({ data: { data: { deliveries: [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }], revision: 'revision' } } });
  await render(<DeliveryOrderModal date="2099-01-05" drivers={[{ _id: 'driver', name: 'Driver' }]} onClose={jest.fn()}/>);
  await act(async () => { const select = host.querySelector('select'); select.value = 'driver'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const earlier = button('Move stop 3 up'); act(() => { earlier.click(); earlier.click(); });
  expect(changes()[1].before).toEqual(changes()[0].after);
  expect(changes()[1].after).toEqual(changes()[0].before);
  expect(changes()[1].after[0]).toContain('a');
});

test('DayPicker dates and mode changes are recorded while the delivery change remains unsaved', async () => {
  await render(<AddDeliveryChange/>); await click('Pick range');
  expect(changes()[0]).toMatchObject({ before: [], after: ['2099-01-05', '2099-01-06'] });
  await click('Select Dates'); await click('Pick multiple');
  expect(changes().some(change => Array.isArray(change.after) && change.after.length === 1 && change.after[0] === '2099-01-05')).toBe(true);
});

test('choosing a role observes the new role and resulting permission defaults before saving', async () => {
  await render(<UserPermissionsModal isOpen user={{ _id: 'user', name: 'Fixture', role: 'viewer' }} onClose={jest.fn()}/>);
  await click('DISPATCHER');
  expect(changes().some(change => change.field === 'User role' && change.before === 'viewer' && change.after === 'dispatcher')).toBe(true);
  expect(changes().some(change => change.field === 'Page permissions')).toBe(true);
});

test('adding and removing a meal component records the unsaved composition', async () => {
  await render(<MealComposer isNew meal={{ id: 'meal', name: 'Chicken', mealKind: 'Main meal', mealType: 'Chicken', components: [{ id: 'protein', type: 'Protein', name: 'Roast' }] }} onSave={jest.fn()}/>);
  await click('Remove Protein component');
  expect(changes()[0]).toMatchObject({ before: ['Protein: Roast'], after: [] });
  await click('Add component'); await click('Carb');
  expect(changes()[1]).toMatchObject({ before: [], after: ['Carb: Not named'] });
});

test('route map arrows capture a draft sequence before apply and preserve rapid moves', async () => {
  api.get.mockResolvedValue({ data: { data: false } });
  const drivers = [{ _id: 'driver', profile: { firstName: 'Aster', vehicleType: 'van' } }];
  const deliveries = ['Birch', 'Cedar', 'Dahlia'].map((customerName, index) => ({ _id: String(index), customerName, driver: drivers[0], routeOrder: index, gpsLocation: { lat: 25.1, lng: 55.2 } }));
  await render(<DriverRouteMap2GIS open asPage date="2099-01-05" drivers={drivers} deliveries={deliveries}/>);
  act(() => [...host.querySelectorAll('button')].find(node => node.textContent.includes('View route')).click());
  await click('Set delivery order manually');
  const earlier = host.querySelectorAll('button[title="Move earlier"]')[2];
  act(() => { earlier.click(); earlier.click(); });
  expect(changes()).toHaveLength(2); expect(changes()[1]).toMatchObject({ before: ['Birch', 'Dahlia', 'Cedar'], after: ['Dahlia', 'Birch', 'Cedar'] });
  expect(api.post).not.toHaveBeenCalledWith('/deliveries/optimize-routes/apply', expect.anything());
});

test('simulation driver, area and hub button choices record readable proposals', async () => {
  api.get.mockResolvedValue({ data: { data: false } });
  const drivers = [{ _id: 'driver', profile: { firstName: 'Aster', vehicleType: 'van' } }];
  await render(<DriverRouteMap2GIS open asPage date="2099-01-05" drivers={drivers} deliveries={[{ _id: 'stop', customerName: 'Birch', zone: 'Marina', gpsLocation: { lat: 25.1, lng: 55.2 } }]}/>);
  await click('Simulate');
  act(() => host.querySelector('[data-testid="sim-areas"] button').click());
  act(() => host.querySelector('[data-testid="sim-hub-vans"] button').click());
  act(() => host.querySelector('[data-testid="sim-drivers"] button').click());
  expect(changes().some(change => change.field === 'Excluded areas' && change.after.includes('Marina'))).toBe(true);
  expect(changes().some(change => change.field === 'Hub vans' && change.after.includes('Aster'))).toBe(true);
  expect(changes().some(change => change.field === 'Excluded drivers' && change.after.includes('Aster'))).toBe(true);
});

test('sticker border buttons and bulk area exclusions observe draft changes', async () => {
  await render(<StickerDesignerModal isOpen deliveries={[{ _id: 'stop', customerName: 'Aster', zone: 'Marina' }]} onClose={jest.fn()}/>);
  await click('Square');
  expect(changes().some(change => change.field === 'Sticker border')).toBe(true);
  const exclude = [...host.querySelectorAll('button')].find(node => node.textContent.trim() === 'Exclude all');
  act(() => exclude.click());
  expect(changes().some(change => change.after.includes?.('Marina'))).toBe(true);
});

test('print configuration bulk area buttons capture before printing', async () => {
  await render(<PrintConfigModal isOpen deliveries={[{ _id: 'stop', zone: 'Marina' }]} onClose={jest.fn()}/>);
  await click('Exclude all areas');
  expect(changes()[0]).toMatchObject({ before: [], after: ['Marina'] });
});

test('removing a bag tag logo records its presence without keeping the image URL', async () => {
  api.get.mockResolvedValue({ data: { url: 'https://fixture.invalid/logo.png' } });
  await render(<BagTagPrintModal isOpen customers={[]} onClose={jest.fn()}/>);
  await click('Remove');
  expect(changes()[0]).toMatchObject({ before: 'Logo selected', after: 'No logo' });
  expect(JSON.stringify(changes())).not.toContain('fixture.invalid');
});

test('event staff row buttons record an unsaved row removal', async () => {
  api.get.mockResolvedValue({ data: { data: [] } });
  await render(<CreateEventModal isOpen onClose={jest.fn()}/>);
  const add = [...host.querySelectorAll('button')].find(node => node.textContent.includes('Add Staff'));
  act(() => add.click());
  expect(changes().some(change => change.field === 'Event staff')).toBe(true);
});

test('event detail food removal records the draft before Update', async () => {
  await render(<EventDetailModal isOpen onClose={jest.fn()}/>); await click('Edit'); await click('Remove');
  expect(changes()[0]).toMatchObject({ before: ['Rice × 2'], after: [] });
});

test('adding a task item records the committed draft before delivery creation', async () => {
  api.get.mockResolvedValue({ data: { data: [] } });
  await render(<AddDelivery/>);
  await click('Task');
  input(host.querySelector('input[placeholder="Add a task item"]'), 'Collect spare bag');
  await click('Add');
  expect(changes().some(change => change.field === 'Task items')).toBe(true);
});

test('subscription pause and return calendar choices are observed before confirmation', async () => {
  api.get.mockImplementation(async path => ({ data: { data: path === '/matter/subscriptions/subscription' ? { data: { subscription_id: 'subscription', name: 'Aster', cycle_end_date: '2099-01-05' } } : [] } }));
  await render(<WebsiteSubscription/>); await click('Pause Delivery');
  const date = [...host.querySelectorAll('button[title]')].find(node => /^\d{4}-\d{2}-\d{2}$/.test(node.title) && !node.disabled);
  act(() => date.click());
  expect(changes().some(change => change.field === 'Pause days' && change.after.includes(date.title))).toBe(true);
  await click('Select return days'); act(() => date.click());
  expect(changes().some(change => change.field === 'Return days' && change.after.includes(date.title))).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

test('removing a partner profile picture records presence rather than the image URL before saving', async () => {
  api.get.mockImplementation(async path => ({ data: { data: path === '/admin/partners' ? [{ _id: 'partner', businessName: 'Fixture partner', businessType: 'cafe', contactName: 'Fixture', accountCategory: 'partner', profilePicture: 'https://fixture.invalid/partner.png' }] : [] } }));
  await render(<AdminPartners/>);
  const edit = [...host.querySelectorAll('button')].find(node => node.textContent.trim() === 'Edit');
  act(() => edit.click()); await click('Remove');
  expect(changes()[0]).toMatchObject({ before: 'Picture selected', after: 'No picture' });
  expect(JSON.stringify(changes())).not.toContain('fixture.invalid');
});

test('adding an equipment option observes its proposal before the optional save request', async () => {
  api.get.mockResolvedValue({ data: { data: [] } });
  await render(<CreateEventModal isOpen onClose={jest.fn()}/>);
  input(host.querySelector('input[placeholder="Equipment name (e.g., Projector)"]'), 'Projector');
  act(() => host.querySelector('input[placeholder="Equipment name (e.g., Projector)"]').parentElement.querySelector('button').click());
  expect(changes().some(change => change.field === 'Equipment options' && change.after.includes('Projector'))).toBe(true);
});

test('clearing simulation area rules observes the return to all areas', async () => {
  api.get.mockResolvedValue({ data: { data: false } });
  await render(<DriverRouteMap2GIS open asPage date="2099-01-05" deliveries={[{ _id: 'stop', zone: 'Marina', gpsLocation: { lat: 25.1, lng: 55.2 } }]} drivers={[]}/>);
  await click('Simulate'); act(() => host.querySelector('[data-testid="sim-areas"] button').click());
  const clear = host.querySelector('[data-testid="sim-areas"]').parentElement.querySelector('button');
  act(() => clear.click());
  expect(changes().some(change => change.field === 'Excluded areas' && change.before.includes('Marina') && change.after.length === 0)).toBe(true);
});

test('choosing a collection customer records the customer chosen before submission', async () => {
  jest.useFakeTimers();
  api.get.mockImplementation(async path=>({ data: { data: path === '/customers' ? [{ _id: 'person', customerId: 'CUST-1', firstName: 'Aster', lastName: 'Fixture' }] : [] } }));
  await render(<AddDelivery/>); await click('Collection');
  input(host.querySelector('input[placeholder="Type customer name or ID to search..."]'), 'Ast');
  await act(async()=>{jest.advanceTimersByTime(300);});
  const customer=[...host.querySelectorAll('button')].find(node=>node.textContent.includes('Aster Fixture'));
  await act(async()=>customer.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})));
  expect(changes().some(change=>change.field==='Collection customer'&&change.after==='Aster Fixture (CUST-1)')).toBe(true);
});

test.each(['current', 'token', 'page', 'selection'])('collection location completion observes only the current initiating context (%s)', async scenario => {
  jest.useFakeTimers(); localStorage.setItem('token', 'fixture-actor'); window.history.replaceState({}, '', '/add-delivery');
  let finish;
  api.get.mockImplementation(async path => {
    if (path === '/customers/CUST-1/location') return new Promise(resolve => { finish=()=>resolve({data:{data:{address:'Saved building',zone:'Marina',gpsLocation:{lat:25.1,lng:55.2}}}}); });
    return {data:{data:path==='/customers'?[{customerId:'CUST-1',firstName:'Aster'},{customerId:'CUST-2',firstName:'Birch'}]:null}};
  });
  await render(<AddDelivery/>); await click('Collection');
  const choose = async name => {
    input(host.querySelector('input[placeholder="Type customer name or ID to search..."]'),name);
    await act(async()=>{jest.advanceTimersByTime(150);});
    await act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent.includes(name)).dispatchEvent(new MouseEvent('mousedown',{bubbles:true})));
  };
  await choose('Aster');
  if(scenario==='token')localStorage.setItem('token','different-actor');
  if(scenario==='page')window.history.replaceState({},'','/customers');
  if(scenario==='selection')await choose('Birch');
  await act(async()=>finish());
  const dependent=changes().filter(change=>['Collection address','Collection area','Collection coordinates'].includes(change.field));
  if(scenario==='current'){
    expect(dependent).toEqual(expect.arrayContaining([expect.objectContaining({field:'Collection address',before:'',after:'Saved building'}),expect.objectContaining({field:'Collection area',before:'',after:'Marina'}),expect.objectContaining({field:'Collection coordinates',before:'Not set',after:'25.100000, 55.200000'})]));
  }else expect(dependent).toEqual([]);
});

test('route timing filter buttons and clearing retain readable before and after choices',async()=>{
  api.get.mockResolvedValue({data:{data:false}});
  await render(<DriverRouteMap2GIS open asPage deliveries={[]} drivers={[]} date="2099-01-05"/>);
  await click('3am');await click('Clear');
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({field:'Delivery timing filter',before:[],after:['3am']}),expect.objectContaining({field:'Delivery timing filter',before:['3am'],after:[]})]));
});
