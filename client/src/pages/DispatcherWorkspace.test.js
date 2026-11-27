import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DispatcherWorkspace from './DispatcherWorkspace';
import api from '../utils/api';
import { dispatchDateWindow, dayRange } from '../utils/dispatcher';
jest.mock('../utils/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn()
  }
}));
jest.mock('react-redux', () => ({
  useSelector: fn => fn({
    auth: {
      user: {
        _id: 'staff',
        role: 'dispatcher',
        name: 'Signed-in dispatcher',
        permissions: {
          bags: true
        }
      }
    }
  }),
  useDispatch: () => jest.fn()
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn()
}), {
  virtual: true
});
let mockSocket = null;
jest.mock('../contexts/SocketContext', () => ({
  useSocket: () => ({
    socket: mockSocket
  })
}));
let mockScan = 'BAG_00001';
jest.mock('../components/SimpleQrScanner', () => ({
  onScan
}) => <button onClick={() => onScan([{
  rawValue: mockScan
}])}>Scan test bag</button>);
global.IS_REACT_ACT_ENVIRONMENT = true;
let container, root, deliveries, drivers;
const fleetFlag = process.env.REACT_APP_DISPATCH_FLEET_ENABLED;
const fleetSessionKey = 'matter-fleet-operation:staff';
const defaultDate = () => dispatchDateWindow().defaultDate;
const buttons = () => [...container.querySelectorAll('button')];
const button = text => buttons().find(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
const click = async text => {
  const b = button(text);
  expect(b).toBeDefined();
  await act(async () => b.click());
};
const fill = async (el, value) => act(async () => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {
    bubbles: true
  }));
});
const submit = async form => act(async () => form.dispatchEvent(new Event('submit', {
  bubbles: true,
  cancelable: true
})));
const select = async name => act(async () => container.querySelector(`[aria-label="Select ${name}"]`).click());
const pickFirst = async () => act(async () => container.querySelector('.dp-driver-choices button').click());
beforeEach(async () => {
  delete process.env.REACT_APP_DISPATCH_FLEET_ENABLED;
  jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
  mockScan = 'BAG_00001';
  mockSocket = null;
  deliveries = [{
    _id: 'delivery-1',
    customerId: 'C001',
    customerName: 'Pending customer',
    address: 'Building One',
    zone: 'Marina',
    status: 'pending',
    type: 'Delivery',
    scheduledTime: defaultDate() + 'T03:00:00Z',
    gpsLocation: {
      lat: 25.08,
      lng: 55.14
    },
    timeline: []
  }, {
    _id: 'delivery-2',
    customerId: 'C002',
    customerName: 'Assigned customer',
    address: 'Building Two',
    zone: 'JVC',
    status: 'assigned',
    driver: {
      _id: 'driver-2',
      name: 'Ravi'
    },
    type: 'Delivery',
    scheduledTime: defaultDate() + 'T04:00:00Z',
    timeline: []
  }];
  drivers = Array.from({
    length: 6
  }, (_, i) => ({
    _id: 'driver-' + (i + 1),
    name: ['Ahmed', 'Ravi', 'Daniel', 'Hassan', 'Mohammed', 'Saif'][i],
    isActive: true
  }));
  for (const method of ['get', 'post', 'patch', 'put']) api[method].mockReset();
  api.get.mockImplementation(async url => {
    if (url === '/dispatcher-location-reviews') return {data:{data:{count:0,rows:[],pages:0}}};
    if (url === '/deliveries') return {
      data: {
        success: true,
        data: {
          deliveries,
          pagination: {
            pages: 1
          }
        }
      }
    };
    if (url === '/users/drivers') return {
      data: {
        data: drivers
      }
    };
    if (url.startsWith('/deliveries/delivery-') && url !== '/deliveries/delivery-order') return {
      data: {
        data: {
          delivery: deliveries.find(d => url.endsWith(d._id))
        }
      }
    };
    if (url === '/bags') return {
      data: {
        data: [{
          _id: 'bag-1',
          bagId: 'BAG-00001',
          lifecycleState: 'ready',
          custodyVersion: 7,
          condition: 'good',
          location: 'warehouse'
        }],
        pagination: {
          totalPages: 1
        }
      }
    };
    if (url === '/dispatcher-handovers') return {
      data: {
        data: {
          receipts: [{
            id: 'receipt',
            dispatcherName: 'Signed-in dispatcher',
            driverName: 'Ravi',
            preparedAt: new Date().toISOString(),
            preparedCount: 2,
            acceptedCount: 1,
            pendingCount: 1,
            status: 'partial',
            bags: [{
              bagId: 'BAG-00001',
              eventId: 'pack1',
              status: 'accepted'
            }, {
              bagId: 'BAG-00002',
              eventId: 'pack2',
              status: 'pending'
            }]
          }]
        }
      }
    };
    if (url === '/deliveries/delivery-order') return {
      data: {
        data: {
          deliveries,
          revision: 'current-revision'
        }
      }
    };
    if (url === '/events') return {
      data: {
        events: []
      }
    };
    throw new Error('Unexpected GET ' + url);
  });
  api.patch.mockResolvedValue({
    data: {
      success: true,
      message: 'Assignment saved'
    }
  });
  api.put.mockResolvedValue({
    data: {
      success: true
    }
  });
  api.post.mockResolvedValue({
    data: {
      success: true
    }
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<DispatcherWorkspace />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.restoreAllMocks();
  if (fleetFlag === undefined) delete process.env.REACT_APP_DISPATCH_FLEET_ENABLED;
  else process.env.REACT_APP_DISPATCH_FLEET_ENABLED = fleetFlag;
  sessionStorage.removeItem(fleetSessionKey);
});

function fleetOptions(load) {
  process.env.REACT_APP_DISPATCH_FLEET_ENABLED = '1';
  const other = api.get.getMockImplementation();
  api.get.mockImplementation((path, ...args) => path === '/dispatcher-fleet/options' ? load() : other(path, ...args));
}

test('a pending fleet save stays reachable during a roster outage and retries its original request', async () => {
  const request = { phase: 'commit', operationId: 'original', reviewProof: 'original-proof',
    command: { kind: 'assign', from: '2026-11-27T08:00:00.000Z', to: null, pairs: [] } };
  sessionStorage.setItem(fleetSessionKey, JSON.stringify(request));
  const roster = jest.fn().mockRejectedValue(new Error('Roster unavailable'));
  fleetOptions(roster);
  api.post.mockRejectedValueOnce(new Error('Could not confirm the save')).mockResolvedValueOnce({
    data: { data: { state: 'saved', operationId: request.operationId } },
  });

  await click('Drivers');
  expect(container.textContent).toContain('Roster unavailable');
  await click('Retry vehicle options');
  expect(roster).toHaveBeenCalledTimes(2);
  await click('Resume vehicle save');
  await click('Retry save');
  expect(JSON.parse(sessionStorage.getItem(fleetSessionKey))).toEqual(request);
  await click('Retry save');
  expect(sessionStorage.getItem(fleetSessionKey)).toBeNull();
  expect(api.post.mock.calls.map(([path, body]) => [path, body])).toEqual([
    ['/dispatcher-fleet', request], ['/dispatcher-fleet', request],
  ]);
  expect(container.textContent).toContain('Vehicle pairing saved.');
});

test('review locks the form during the request and save uses the submitted command', async () => {
  fleetOptions(async () => ({ data: { data: [{ id: 'van', label: 'Van 1', type: 'van' },
    { id: 'bike', label: 'Bike 1', type: 'bike' }],
    drivers: [{ _id: 'driver-1', name: 'Fleet driver', isActive: true }] } }));
  let finishReview;
  const review = { operationId: 'reviewed', reviewProof: 'proof', current: [], expected: [], expectedAssets: [] };
  api.post.mockImplementationOnce(() => new Promise(resolve => { finishReview = resolve; })).mockResolvedValueOnce({
    data: { data: { state: 'saved', operationId: review.operationId } },
  });

  await click('Drivers');
  await click('Vehicle assignment');
  const dialog = container.querySelector('[role="dialog"]');
  await fill(dialog.querySelector('select[name="driverId"]'), 'driver-1');
  const vehicle = dialog.querySelector('select[name="vehicleId"]');
  await fill(vehicle, 'van');
  await act(async () => dialog.querySelector('input[name="ongoing"]').click());
  await click('Review pairing');
  const submitted = api.post.mock.calls[0][1].command;
  expect(vehicle.disabled).toBe(true);
  await fill(vehicle, 'bike');
  await act(async () => finishReview({ data: { data: review } }));
  await click('Save pairing');
  expect(api.post.mock.calls[1][1]).toEqual({
    phase: 'commit', operationId: review.operationId, reviewProof: review.reviewProof,
    command: { ...submitted, expected: review.expected, expectedAssets: review.expectedAssets },
  });
  expect(submitted.pairs[0].sourceVehicleId).toBe('van');
});

test('inactive drivers with current ledger custody can be selected only for End assignment', async () => {
  drivers.push({ _id: 'former', name: 'Former driver', isActive: false },
    { _id: 'other', name: 'Other inactive driver', isActive: false });
  // The fleet form receives only the minimal authorized roster.
  await act(async () => root.render(null));
  fleetOptions(async () => ({ data: { data: [],
    drivers: [{ _id: 'former', name: 'Former driver', isActive: false }] } }));
  await act(async () => root.render(<DispatcherWorkspace />));
  await click('Drivers');
  await click('Vehicle assignment');
  const dialog = container.querySelector('[role="dialog"]');
  const driver = dialog.querySelector('select[name="driverId"]');
  expect(driver.querySelector('option[value="former"]')).toBeNull();
  await fill(dialog.querySelector('select[name="kind"]'), 'end');
  expect(driver.querySelector('option[value="former"]').textContent).toContain('Former driver');
  expect(driver.querySelector('option[value="other"]')).toBeNull();
});
test('advanced and driver filters are available without print, routing or grid controls', () => {
  expect(container.querySelectorAll('.dp-filter-trigger:not(.dp-driver-filter)')).toHaveLength(1);
  expect(button('Filter by driver')).toBeDefined();
  expect(buttons().map(b => b.textContent).join(' ')).not.toMatch(/Grid view|Map assignment|Driver routes|Print/);
  expect(api.post).not.toHaveBeenCalled();
});
test('filter searches retain multiselection across search terms', async () => {
  await act(async () => container.querySelector('.dp-filter-trigger').click());
  await fill(container.querySelector('[aria-label="Search zones"]'), 'mar');
  await click('Marina');
  await fill(container.querySelector('[aria-label="Search zones"]'), 'jvc');
  await click('JVC');
  await fill(container.querySelector('[aria-label="Search drivers"]'), 'ravi');
  await click('Ravi');
  await fill(container.querySelector('[aria-label="Search drivers"]'), 'none');
  expect(container.textContent).toContain('No drivers match');
  await click('Apply filters');
  expect(container.querySelector('.dp-filter-trigger').textContent).toContain('3 selected');
  expect(container.querySelectorAll('.dp-delivery-card')).toHaveLength(1);
  expect(container.querySelector('.dp-delivery-card').textContent).toContain('Assigned customer');
});
test('date choice loads the Dubai day and clears prior selection', async () => {
  await select('Pending customer');
  await act(async () => container.querySelector('.dp-date').click());
  await fill(container.querySelector('input[type="date"]'), '2026-12-21');
  await submit(container.querySelector('[role="dialog"] form'));
  expect(api.get).toHaveBeenCalledWith('/deliveries', expect.objectContaining({
    params: expect.objectContaining(dayRange('2026-12-21'))
  }));
  expect(container.querySelector('.dp-selection')).toBeNull();
});
test('an open board switches to tomorrow at 9 a.m. Dubai time and clears checked rows', async () => {
  await act(async () => root.render(null));
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date('2026-11-24T04:59:59Z'));
    deliveries = [
      { ...deliveries[0], scheduledTime: '2026-11-24T03:00:00Z' },
      { ...deliveries[1], scheduledTime: '2026-11-25T04:00:00Z' }
    ];
    await act(async () => root.render(<DispatcherWorkspace />));
    expect(container.querySelector('.dp-date').textContent).toContain('Today');
    expect(container.querySelector('.dp-delivery-card').textContent).toContain('Pending customer');
    await select('Pending customer');
    await act(async () => jest.advanceTimersByTime(1000));
    expect(api.get).toHaveBeenLastCalledWith('/deliveries', expect.objectContaining({
      params: expect.objectContaining(dayRange('2026-11-25'))
    }));
    expect(container.querySelector('.dp-date').textContent).toContain('Tomorrow');
    expect(container.querySelector('.dp-delivery-card').textContent).toContain('Assigned customer');
    expect(container.querySelector('.dp-selection')).toBeNull();
  } finally {
    await act(async () => root.render(null));
    jest.useRealTimers();
  }
});
test('choosing Today before the Dubai cutoff keeps that date after 9 a.m.', async () => {
  await act(async () => root.render(null));
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date('2026-11-24T04:59:59Z'));
    deliveries[0].scheduledTime = '2026-11-24T03:00:00Z';
    await act(async () => root.render(<DispatcherWorkspace />));
    await act(async () => container.querySelector('.dp-date').click());
    await click('Today');
    await act(async () => jest.advanceTimersByTime(1000));
    expect(container.querySelector('.dp-date').textContent).toContain('Today');
    expect(container.querySelector('.dp-delivery-card').textContent).toContain('Pending customer');
  } finally {
    await act(async () => root.render(null));
    jest.useRealTimers();
  }
});
test('Dubai midnight refreshes an open new-customer list on the same dispatch date', async () => {
  await act(async () => root.render(null));
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date('2026-11-24T19:59:59Z'));
    const get = api.get.getMockImplementation();
    const yesterday = { subscriptionId: 'yesterday', customerName: 'Yesterday customer' };
    let upcoming = [yesterday];
    api.get.mockImplementation((url, config) => url === '/dispatcher-location-reviews'
      ? Promise.resolve({ data: { data: { count: upcoming.length, rows: upcoming, pages: upcoming.length } } })
      : get(url, config));
    await act(async () => root.render(<DispatcherWorkspace />));
    await click('New customer, 1');
    expect(container.querySelector('.dp-new-customer-list button').textContent).toContain(yesterday.customerName);
    const deliveryCalls = api.get.mock.calls.filter(([url]) => url === '/deliveries').length;
    upcoming = [];
    await act(async () => jest.advanceTimersByTime(1000));
    expect(container.querySelector('.dp-date').textContent).toContain('Today');
    expect(container.querySelector('.dp-new-customer-list button')).toBeNull();
    expect(button('New customer, 0')).toBeDefined();
    expect(api.get.mock.calls.filter(([url]) => url === '/deliveries')).toHaveLength(deliveryCalls);
  } finally {
    await act(async () => root.render(null));
    jest.useRealTimers();
  }
});
test('bulk assignment posts selected real IDs after confirmation', async () => {
  await select('Pending customer');
  await click('Assign / reassign');
  await fill(container.querySelector('[aria-label="Search assignment drivers"]'), 'ravi');
  await pickFirst();
  expect(api.patch).not.toHaveBeenCalled();
  await click('Confirm assignment');
  expect(api.patch).toHaveBeenCalledWith('/deliveries/assign-driver', {
    deliveryIds: ['delivery-1'],
    driverId: 'driver-2'
  });
});
test('failed assignment stays open for retry with an error', async () => {
  api.patch.mockRejectedValueOnce({
    response: {
      data: {
        message: 'Assignment rejected'
      }
    }
  });
  await select('Pending customer');
  await click('Assign / reassign');
  await pickFirst();
  await click('Confirm assignment');
  expect(container.querySelector('[role="alert"]').textContent).toContain('Assignment rejected');
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});
test('unassign confirmation sends only selected assigned deliveries', async () => {
  await select('Assigned customer');
  await click('Unassign');
  expect(api.patch).not.toHaveBeenCalled();
  await click('Confirm unassign');
  expect(api.patch).toHaveBeenCalledWith('/deliveries/unassign-driver', {
    deliveryIds: ['delivery-2']
  });
});
test('details show saved coordinates and never invent an absent pin', async () => {
  await click('Open Pending customer');
  expect(container.textContent).toContain('25.080000');
  await click('Close dialog');
  await click('Open Assigned customer');
  expect(container.textContent).toContain('No saved pin');
  expect(container.querySelectorAll('.dp-proof img')).toHaveLength(0);
});
test('new delivery submits entered fields and Dubai time', async () => {
  await click('New delivery');
  const inputs = [...container.querySelectorAll('[role="dialog"] input')],
    named = label => inputs.find(i => i.closest('label').textContent === label);
  await fill(named('Customer name'), 'New customer');
  await fill(named('Customer ID'), 'C900');
  await fill(named('Address'), 'Actual building');
  await submit(container.querySelector('[role="dialog"] form'));
  expect(api.post).toHaveBeenCalledWith('/deliveries', expect.objectContaining({
    customerName: 'New customer',
    customerId: 'C900',
    address: 'Actual building',
    scheduledTime: defaultDate() + 'T03:00:00.000Z'
  }));
});
test('ordering saves the entire driver schedule and revision', async () => {
  await click('Arrange order');
  await fill(container.querySelector('[role="dialog"] select'), 'driver-2');
  await click('Move stop 2 up');
  await click('Apply order');
  expect(api.put).toHaveBeenCalledWith('/deliveries/delivery-order', {
    driverId: 'driver-2',
    date: defaultDate(),
    revision: 'current-revision',
    deliveryIds: ['delivery-2', 'delivery-1']
  });
});
const reviewHandover = async () => {
  await click('Handover');
  await fill(container.querySelector('[aria-label="Search receiving drivers"]'), 'ravi');
  await pickFirst();
  await click('Continue to bags');
  await click('Start camera');
  await click('Scan test bag');
  await click('Review handover');
};
test('handover lists every active driver, exact scanned tags and explicit confirmation', async () => {
  await click('Handover');
  expect(container.querySelectorAll('.dp-driver-choices button')).toHaveLength(6);
  await fill(container.querySelector('[aria-label="Search receiving drivers"]'), ' saif ');
  expect(container.querySelectorAll('.dp-driver-choices button')).toHaveLength(1);
  await pickFirst();
  await click('Continue to bags');
  await click('Start camera');
  await click('Scan test bag');
  await click('Review handover');
  expect(api.post).not.toHaveBeenCalled();
  expect(button('Confirm physical handover').disabled).toBe(true);
  await act(async () => container.querySelector('.dp-check input').click());
  api.post.mockResolvedValueOnce({
    data: {
      data: {
        id: 'receipt',
        successes: [{
          bagId: 'BAG-00001'
        }],
        failures: []
      }
    }
  });
  await click('Confirm physical handover');
  expect(api.post).toHaveBeenCalledWith('/dispatcher-handovers', expect.objectContaining({
    driverId: 'driver-6',
    bags: [{
      bagId: 'BAG-00001',
      expectedVersion: 7
    }],
    requestId: expect.stringMatching(/^[a-f0-9-]{36}$/i)
  }));
  expect(container.textContent).toContain('1 bags prepared');
  expect(container.textContent).toContain('remain in warehouse custody');
});
test('uncertain handover retries its original request and never accepts on behalf of a driver', async () => {
  await reviewHandover();
  await act(async () => container.querySelector('.dp-check input').click());
  api.post.mockRejectedValueOnce(new Error('Network lost'));
  await click('Confirm physical handover');
  api.post.mockResolvedValueOnce({
    data: {
      data: {
        id: 'receipt',
        successes: [{
          bagId: 'BAG-00001'
        }],
        failures: []
      }
    }
  });
  await click('Retry handover');
  expect(api.post.mock.calls[1][1]).toEqual(api.post.mock.calls[0][1]);
  expect(api.post.mock.calls.some(([, body]) => body.action === 'accept')).toBe(false);
});
test('history keeps server-prepared and accepted quantities distinct', async () => {
  await click('History');
  expect(container.querySelector('.dp-receipt-card').textContent).toContain('2 prepared · 1 accepted');
  await act(async () => container.querySelector('.dp-receipt-card').click());
  expect(container.querySelector('[role="dialog"]').textContent).toContain('BAG-00002');
  expect(container.querySelector('[role="dialog"]').textContent).toContain('pending');
});
test('handover rejects oversized scans and permits removing a mistaken bag', async () => {
  await click('Handover');
  await pickFirst();
  await click('Continue to bags');
  await click('Start camera');
  mockScan = 'X'.repeat(161);
  await click('Scan test bag');
  expect(container.querySelector('[role="alert"]').textContent).toContain('160 characters');
  expect(container.querySelectorAll('.dp-taglist>span')).toHaveLength(0);
  mockScan = 'BAG_00001';
  await click('Scan test bag');
  expect(container.querySelectorAll('.dp-taglist>span')).toHaveLength(1);
  await click('Remove BAG-00001');
  expect(container.querySelectorAll('.dp-taglist>span')).toHaveLength(0);
  expect(button('Review handover').disabled).toBe(true);
});
test('older delivery requests cannot overwrite a newer selected day', async () => {
  const original = api.get.getMockImplementation();
  let resolveFirst, resolveSecond;
  api.get.mockImplementation((url, config) => {
    if (url === '/deliveries' && config.params.dateFrom === dayRange('2026-12-20').dateFrom) return new Promise(resolve => {
      resolveFirst = resolve;
    });
    if (url === '/deliveries' && config.params.dateFrom === dayRange('2026-12-21').dateFrom) return new Promise(resolve => {
      resolveSecond = resolve;
    });
    return original(url, config);
  });
  for (const date of ['2026-12-20', '2026-12-21']) {
    await act(async () => container.querySelector('.dp-date').click());
    await fill(container.querySelector('input[type="date"]'), date);
    await submit(container.querySelector('[role="dialog"] form'));
  }
  await act(async () => resolveSecond({
    data: {
      data: {
        deliveries: [{
          ...deliveries[0],
          customerName: 'Newest day',
          scheduledTime: '2026-12-21T03:00:00Z'
        }],
        pagination: {
          pages: 1
        }
      }
    }
  }));
  await act(async () => resolveFirst({
    data: {
      data: {
        deliveries: [{
          ...deliveries[0],
          customerName: 'Older day',
          scheduledTime: '2026-12-20T03:00:00Z'
        }],
        pagination: {
          pages: 1
        }
      }
    }
  }));
  expect(container.textContent).toContain('Newest day');
  expect(container.textContent).not.toContain('Older day');
});


test('driver status events refresh the delivery board and accepted handover history, then unsubscribe', async () => {
  const listeners = new Map();
  mockSocket = {
    on: jest.fn((event, listener) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); }),
    off: jest.fn((event, listener) => listeners.get(event)?.delete(listener))
  };
  let accepted = 1;
  const original = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const response = await original(url, config);
    if (url !== '/dispatcher-handovers') return response;
    return { data: { data: { receipts: response.data.data.receipts.map(r => ({
      ...r, acceptedCount: accepted, pendingCount: 2 - accepted, status: accepted === 2 ? 'accepted' : 'partial'
    })), truncated: false } } };
  });
  await act(async () => root.render(<DispatcherWorkspace />));
  await click('History');
  expect(container.querySelector('.dp-receipt-card').textContent).toContain('1 accepted');
  expect(listeners.has('delivery:statusUpdate')).toBe(true);
  jest.useFakeTimers();
  try {
    accepted = 2;
    deliveries = deliveries.map((d, i) => i === 0 ? { ...d, status: 'on_route' } : d);
    api.get.mockClear();
    await act(async () => {
      listeners.get('delivery:statusUpdate').forEach(listener => listener({ status: 'on_route' }));
      jest.advanceTimersByTime(351);
    });
    expect(api.get).toHaveBeenCalledWith('/dispatcher-handovers');
    expect(api.get).toHaveBeenCalledWith('/deliveries', expect.any(Object));
    expect(container.querySelector('.dp-receipt-card').textContent).toContain('2 accepted');
    await click('Dispatch');
    expect(container.querySelector('.dp-table-wrap').textContent).toContain('on route');
    deliveries = deliveries.map((d, i) => i === 0 ? { ...d, status: 'delivered' } : d);
    await act(async () => {
      listeners.get('delivery:statusUpdate').forEach(listener => listener({ status: 'delivered' }));
      jest.advanceTimersByTime(351);
    });
    expect(container.querySelector('.dp-table-wrap').textContent).toContain('delivered');
    await act(async () => root.render(null));
    expect(mockSocket.off).toHaveBeenCalledWith('delivery:statusUpdate', expect.any(Function));
  } finally {
    jest.useRealTimers();
  }
});

test('refresh returns to the last valid page when assignment shrinks filtered deliveries', async () => {
  deliveries = Array.from({length:31}, (_, i) => ({...deliveries[0], _id:'delivery-'+i, customerId:'C'+i, customerName:'Fixture '+i}));
  await click('Refresh deliveries');
  await click('Unassigned');
  await click('Next');
  expect(container.querySelector('.dp-table-wrap').textContent).toContain('Fixture 30');
  deliveries = deliveries.map((d,i) => i === 30 ? {...d, driver:drivers[0], status:'assigned'} : d);
  await click('Refresh deliveries');
  expect(container.querySelector('.dp-table-wrap tbody tr')).not.toBeNull();
  expect(container.querySelector('.dp-table-wrap').textContent).toContain('Fixture 0');
  expect(container.querySelector('.dp-board-footer').textContent).toContain('30 matching deliveries');
});

test('refresh clamps to a remaining later page and keeps its navigation usable', async () => {
  deliveries = Array.from({length:61}, (_, i) => ({...deliveries[0], _id:'delivery-'+i, customerId:'C'+i, customerName:'Fixture '+i}));
  await click('Refresh deliveries');
  await click('Next');
  await click('Next');
  expect(container.querySelector('.dp-table-wrap').textContent).toContain('Fixture 60');
  deliveries = deliveries.slice(0,31);
  await click('Refresh deliveries');
  expect(container.querySelector('.dp-table-wrap').textContent).toContain('Fixture 30');
  expect(container.querySelector('.dp-board-footer').textContent).toContain('2 / 2');
  await click('Previous');
  expect(container.querySelector('.dp-table-wrap').textContent).toContain('Fixture 0');
});

test('plain-array driver endpoint populates active drivers and permits bulk select-all assignment across pages',async()=>{
 const original=api.get.getMockImplementation();api.get.mockImplementation(async(url,config)=>url==='/users/drivers'?{data:[...drivers,{_id:'inactive',name:'Inactive driver',isActive:false}]}:original(url,config));
 deliveries=Array.from({length:35},(_,i)=>({...deliveries[0],_id:'delivery-'+i,customerName:'Bulk '+i}));
 await click('Retry drivers').catch(()=>{});
 // Remount to exercise the actual initial plain-array response.
 await act(async()=>root.render(null));await act(async()=>root.render(<DispatcherWorkspace/>));
 await click('Select all deliveries');expect(container.querySelector('.dp-selection').textContent).toContain('35 selected');await click('Assign / reassign');
 expect(container.querySelectorAll('.dp-driver-choices button')).toHaveLength(6);
 expect(container.textContent).not.toContain('Inactive driver');
 await act(async()=>[...container.querySelectorAll('.dp-driver-choices button')].find(b=>b.querySelector('strong').textContent==='Saif').click());
 await click('Confirm assignment');
 expect(api.patch).toHaveBeenCalledWith('/deliveries/assign-driver',expect.objectContaining({deliveryIds:deliveries.map(d=>d._id),driverId:'driver-6'}));
});
test('zone counts show available work and change to remaining unassigned work after assignment',async()=>{
 await act(async()=>container.querySelector('.dp-filter-trigger').click());
 expect(button('Marina').textContent).toContain('1 available');expect(button('JVC').textContent).toContain('1 available');await click('Close dialog');await click('Unassigned');
 await act(async()=>container.querySelector('.dp-filter-trigger').click());expect(button('Marina').textContent).toContain('1 unassigned');expect(button('JVC').textContent).toContain('0 unassigned');await click('Close dialog');
 deliveries=deliveries.map(d=>d._id==='delivery-1'?{...d,driver:drivers[0],status:'assigned'}:d);await click('Refresh deliveries');await act(async()=>container.querySelector('.dp-filter-trigger').click());expect(button('Marina').textContent).toContain('0 unassigned');
});


test('unassigning a driver increases the unassigned zone count and select-all excludes completed deliveries',async()=>{
 const original=api.patch.getMockImplementation();api.patch.mockImplementation(async(url,body)=>{if(url==='/deliveries/unassign-driver')deliveries=deliveries.map(d=>body.deliveryIds.includes(d._id)?{...d,driver:null,status:'pending'}:d);return original(url,body);});
 await select('Assigned customer');await click('Unassign');await click('Confirm unassign');await click('Unassigned');await act(async()=>container.querySelector('.dp-filter-trigger').click());expect(button('JVC').textContent).toContain('1 unassigned');await click('Close dialog');await click('Unassigned');
 deliveries=[...deliveries,{...deliveries[0],_id:'finished',status:'delivered',customerName:'Finished customer'}];await click('Refresh deliveries');await click('Select all deliveries');expect(container.querySelector('.dp-selection').textContent).toContain('2 selected');
});

test('quick driver filter shows only the selected driver and clears hidden bulk selections', async () => {
  await select('Pending customer');
  await click('Unassigned');
  await click('Filter by driver');
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog.getAttribute('aria-label')).toBe('Filter by driver');
  expect(dialog.querySelector('[aria-label="Search zones"]')).toBeNull();
  expect(dialog.querySelector('[aria-label="Drivers options"]').querySelectorAll('button')).toHaveLength(7);
  await fill(dialog.querySelector('[aria-label="Search drivers"]'), 'ravi');
  await click('Ravi');
  await click('Show deliveries');
  expect(button('Filter by driver').textContent).toContain('Ravi');
  expect(button('Unassigned').getAttribute('aria-pressed')).toBe('false');
  expect(container.querySelector('.dp-selection')).toBeNull();
  expect(container.querySelectorAll('.dp-delivery-card')).toHaveLength(1);
  expect(container.querySelector('.dp-delivery-card').textContent).toContain('Assigned customer');
  await click('Select all deliveries');
  expect(container.querySelector('.dp-selection').textContent).toContain('1 selected');
  expect(api.patch).not.toHaveBeenCalled();
});

test('quick and advanced driver filters stay in sync and clearing drivers preserves other filters', async () => {
  const openAdvanced = () => act(async () => container.querySelector('.dp-board-filters .dp-filter-trigger:not(.dp-driver-filter)').click());
  await openAdvanced();
  await click('JVC');
  await click('Ravi');
  await click('Apply filters');
  expect(button('Filter by driver').textContent).toContain('Ravi');
  await click('Filter by driver');
  expect(button('Ravi').getAttribute('aria-pressed')).toBe('true');
  await click('Clear drivers');
  await click('Show deliveries');
  expect(button('Filter by driver').textContent).toContain('All drivers');
  expect(container.querySelectorAll('.dp-delivery-card')).toHaveLength(1);
  await openAdvanced();
  expect(button('JVC').getAttribute('aria-pressed')).toBe('true');
  expect(button('Ravi').getAttribute('aria-pressed')).toBe('false');
});

test('board actions align in one group and show saved addresses in both delivery layouts', () => {
  const actions = container.querySelector('.dp-board-actions');
  expect(actions.contains(button('Select all deliveries'))).toBe(true);
  expect(actions.querySelector('.dp-new-customer-button')).not.toBeNull();
  expect(container.querySelector('.dp-delivery-card .dp-card-address').textContent).toBe('Building One');
  expect(container.querySelector('.dp-table-address').textContent).toBe('Building One');
});

test('successful assignment clears the active filters and keeps the same delivery date', async () => {
  await fill(container.querySelector('[aria-label="Search deliveries"]'), 'Pending customer');
  await click('Unassigned');
  await act(async () => container.querySelector('.dp-filter-trigger').click());
  await click('Marina');
  await click('Apply filters');
  const date = container.querySelector('.dp-date').textContent;
  await select('Pending customer');
  await click('Assign / reassign');
  await pickFirst();
  await click('Confirm assignment');
  expect(container.querySelector('[aria-label="Search deliveries"]').value).toBe('');
  expect(button('Unassigned').getAttribute('aria-pressed')).toBe('false');
  expect(container.querySelector('.dp-filter-trigger').textContent).toContain('All');
  expect(container.querySelector('.dp-date').textContent).toBe(date);
  expect(container.querySelectorAll('.dp-delivery-card')).toHaveLength(2);
});

test('the zone filter grays out only zones with zero unassigned deliveries in Unassigned view', async () => {
  await act(async () => container.querySelector('.dp-filter-trigger').click());
  expect(button('JVC').classList.contains('dp-zone-empty')).toBe(false);
  await click('Close dialog');
  await click('Unassigned');
  await act(async () => container.querySelector('.dp-filter-trigger').click());
  expect(button('JVC').classList.contains('dp-zone-empty')).toBe(true);
  expect(button('JVC').textContent).toContain('0 unassigned');
  expect(button('Marina').classList.contains('dp-zone-empty')).toBe(false);
});
