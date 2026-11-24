import { dispatchDateWindow, dayRange, shiftDay, emptyFilters, filterDispatchDeliveries, loadDispatchDay, proofImageUrl } from './dispatcher';

test.each([
  ['2026-11-23T20:00:00.000Z', '2026-11-24', '2026-11-24T05:00:00.000Z'],
  ['2026-11-24T04:59:59.999Z', '2026-11-24', '2026-11-24T05:00:00.000Z'],
  ['2026-11-24T05:00:00.000Z', '2026-11-25', '2026-11-24T20:00:00.000Z'],
  ['2026-11-24T19:59:59.999Z', '2026-11-25', '2026-11-24T20:00:00.000Z']
])('the dispatcher date and next Dubai cutoff at %s', (instant, date, nextBoundary) => {
  expect(dispatchDateWindow(new Date(instant))).toEqual({
    today: '2026-11-24',
    defaultDate: date,
    nextBoundary: new Date(nextBoundary)
  });
});
test('Dubai day bounds are fixed and exclude next midnight', () => {
  expect(dayRange('2026-11-23')).toEqual({
    dateFrom: '2026-11-22T20:00:00.000Z',
    dateTo: '2026-11-23T19:59:59.999Z'
  });
  expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
});
test('filters combine actual zones, drivers, normalized emirates and Dubai hours', () => {
  const d = {
    _id: 'd',
    customerName: 'Nora',
    address: 'Building 10',
    zone: 'Marina',
    driver: {
      _id: 'driver'
    },
    scheduledTime: '2026-11-23T03:00:00Z',
    addressDetails: {
      city: 'DUBAI - Marina'
    },
    status: 'assigned'
  };
  expect(filterDispatchDeliveries([d], {
    date: '2026-11-23',
    search: 'Building',
    filters: {
      zones: ['Marina'],
      drivers: ['driver'],
      hours: ['7'],
      emirates: ['Dubai']
    }
  })).toEqual([d]);
  expect(filterDispatchDeliveries([d], {
    date: '2026-11-23',
    filters: {
      ...emptyFilters(),
      hours: ['3']
    }
  })).toEqual([]);
});
test('Saturday retains Sunday-only meals carried by the server', () => {
  const d = {
    _id: 's',
    scheduledTime: '2026-11-29T03:00:00Z',
    sundayOnlyCarriedOver: true
  };
  expect(filterDispatchDeliveries([d], {
    date: '2026-11-28'
  })).toEqual([d]);
  expect(filterDispatchDeliveries([d], {
    date: '2026-11-27'
  })).toEqual([]);
});
test('loading follows all pages and deduplicates carried weekend records', async () => {
  const api = {
    get: jest.fn().mockResolvedValueOnce({
      data: {
        data: {
          deliveries: [{
            _id: '1'
          }, {
            _id: 'extra'
          }],
          pagination: {
            pages: 2
          }
        }
      }
    }).mockResolvedValueOnce({
      data: {
        data: {
          deliveries: [{
            _id: '2'
          }, {
            _id: 'extra'
          }],
          pagination: {
            pages: 2
          }
        }
      }
    })
  };
  expect((await loadDispatchDay(api, '2026-11-23')).map(d => d._id)).toEqual(['1', 'extra', '2']);
  expect(api.get.mock.calls[1][1].params.page).toBe(2);
  expect(api.get.mock.calls[0][1].params.limit).toBe(500);
});
test('failed subsequent pages never return an incomplete board', async () => {
  const api = {
    get: jest.fn().mockResolvedValueOnce({
      data: {
        data: {
          deliveries: [{
            _id: '1'
          }],
          pagination: {
            pages: 2
          }
        }
      }
    }).mockRejectedValueOnce(new Error('Page failed'))
  };
  await expect(loadDispatchDay(api, '2026-11-23')).rejects.toThrow('Page failed');
});


test('proof upload references resolve against the API host, including a separate local development port',()=>{
 for(const stored of ['/uploads/proofImage-123.jpg','uploads/proofImage-123.jpg','proofImage-123.jpg'])expect(proofImageUrl(stored,'http://localhost:5000/api','http://localhost:3000')).toBe('http://localhost:5000/uploads/proofImage-123.jpg');
 expect(proofImageUrl('/uploads/proof.jpg','/api','https://app.example')).toBe('https://app.example/uploads/proof.jpg');
});
test('absolute proof preserves signed CDN queries and encoded upload filenames resolve once',()=>{
 const signed='https://cdn.example/proof.jpg?signature=abc%2F123';expect(proofImageUrl(signed,'https://api.example/api')).toBe(signed);
 expect(proofImageUrl('/uploads/proof%20photo.jpg','https://api.example/api')).toBe('https://api.example/uploads/proof%20photo.jpg');
});
test('unsafe proof schemes, traversals and non-upload paths are excluded',()=>{
 for(const value of [null,{},'', 'javascript:alert(1)','data:image/svg+xml,svg','//other.example/a.jpg','/private/a.jpg','/uploads/../private.jpg','/uploads/%2e%2e/private.jpg','../a.jpg','/uploads/%2f%2fother.example/a.jpg'])expect(proofImageUrl(value,'https://api.example/api')).toBeNull();
});
