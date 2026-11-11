jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn()}}));
import {dubaiToday,serviceFiltersFromSearch,serviceFilterSearch} from './serviceUtils';
test('Dubai Today changes at 20:00 UTC, independent of the browser timezone',()=>{
 expect(dubaiToday('2026-11-06T19:59:59Z')).toBe('2026-11-06');expect(dubaiToday('2026-11-06T20:00:00Z')).toBe('2026-11-07');
 expect(serviceFiltersFromSearch('',new Date('2026-11-06T20:00:00Z'))).toEqual({from:'2026-11-07',to:'2026-11-07',categoryId:'',search:''});
});
test('explicit custom range and All time round trip through navigation/reload URLs',()=>{
 const range={from:'2026-10-01',to:'2026-10-03',categoryId:'delivery',search:'A&B'};expect(serviceFiltersFromSearch(serviceFilterSearch(range))).toEqual(range);
 expect(serviceFiltersFromSearch('?period=all').from).toBe('');expect(serviceFiltersFromSearch('?period=today',new Date('2026-11-07T21:00:00Z')).from).toBe('2026-11-08');
 expect(serviceFiltersFromSearch('?from=garbage&to=invalid',new Date('2026-11-06T00:00:00Z')).from).toBe('2026-11-06');
});
test.each([{from:'2026-08-08',to:''},{from:'',to:'2026-08-31'}])('a partially entered custom range survives navigation: %j',range=>{
 const filters={...range,categoryId:'',search:''};
 expect(serviceFiltersFromSearch(serviceFilterSearch(filters))).toEqual(filters);
});

test('tomorrow quick due date follows Dubai day boundaries and month rollover',()=>{const {tomorrowDubaiAtTen}=require('./serviceUtils');expect(tomorrowDubaiAtTen('2026-11-30T20:30:00Z')).toBe('2026-12-02T10:00');expect(tomorrowDubaiAtTen('2026-11-30T19:59:00Z')).toBe('2026-12-01T10:00');});

test('changing search and date filters preserves inbox status, assignment and selected thread',()=>{const {updateServiceFilterSearch}=require('./serviceUtils');const query=new URLSearchParams(updateServiceFilterSearch({from:'',to:'',search:'Lucas',categoryId:''},'?period=today&status=all&assignment=assigned&conversation=thread&request=request'));expect(Object.fromEntries(query)).toEqual({period:'all',q:'Lucas',status:'all',assignment:'assigned',conversation:'thread',request:'request'});});
