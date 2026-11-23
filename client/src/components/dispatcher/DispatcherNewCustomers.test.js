import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import DispatcherNewCustomers from './DispatcherNewCustomers';
import api from '../../utils/api';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
let mockSocket=null;
jest.mock('../../contexts/SocketContext',()=>({useSocket:()=>({socket:mockSocket})}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let el,root,detail;
const button=t=>[...el.querySelectorAll('button')].find(b=>b.textContent.trim()===t||b.getAttribute('aria-label')===t);
const click=async t=>act(async()=>{expect(button(t)).toBeDefined();button(t).click();});
const fill=async(node,value)=>act(async()=>{const proto=node.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));});
const open=async()=>{await click('New customer, 1');await act(async()=>el.querySelector('.dp-new-customer-list button').click());};
beforeEach(async()=>{
 mockSocket=null;
 detail={customerId:'42',subscriptionId:'7',customerName:'Fixture customer',location:'Fixture tower, Marina',zone:'Marina',pin:{lat:25,lng:55},revision:'a'.repeat(64),reviews:[]};
 api.get.mockReset();api.post.mockReset();api.get.mockImplementation(async(url,config)=>({data:{data:url==='/dispatcher-location-reviews'?{count:1,rows:config?.params?.details?[detail]:[],pages:2}:detail}}));
 api.post.mockImplementation(async(url,body)=>({data:{data:{review:{...body,actorName:'Signed-in dispatcher',timestamp:'2026-11-23T07:00:00Z'}}}}));
 el=document.createElement('div');document.body.append(el);root=createRoot(el);await act(async()=>root.render(<DispatcherNewCustomers/>));
});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
test('badge uses API customer count and list displays location and zone',async()=>{expect(button('New customer, 1')).toBeDefined();await click('New customer, 1');expect(el.textContent).toContain('Fixture tower, Marina');expect(el.textContent).toContain('awaiting their first completed delivery');expect(api.get).toHaveBeenCalledWith('/dispatcher-location-reviews',{params:{details:true,page:1}});});
test('detail opens Google Maps using saved coordinates and confirmation persists source revision',async()=>{await open();expect(el.querySelector('iframe').getAttribute('src')).toBe('https://www.google.com/maps?q=25,55&output=embed');expect(el.querySelector('a[href]').href).toBe('https://www.google.com/maps/search/?api=1&query=25%2C55');await click('Confirm location');expect(api.post).toHaveBeenCalledWith('/dispatcher-location-reviews/7',expect.objectContaining({action:'confirm',revision:'a'.repeat(64),category:'',issue:''}));expect(el.textContent).toContain('Location confirmed.');expect(el.textContent).toContain('Signed-in dispatcher');});
test('feedback offers requested categories and records issue text in history',async()=>{await open();await click('Give feedback');expect([...el.querySelector('select').options].map(o=>o.text)).toEqual(['Choose an issue','Location incorrect','Missing information','GPS wrong']);await fill(el.querySelector('select'),'gps_wrong');await fill(el.querySelector('textarea'),'Pin is at the wrong entrance');await act(async()=>el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(api.post).toHaveBeenCalledWith('/dispatcher-location-reviews/7',expect.objectContaining({action:'feedback',category:'gps_wrong',issue:'Pin is at the wrong entrance'}));expect(el.textContent).toContain('Feedback saved.');expect(el.textContent).toContain('Pin is at the wrong entrance');});
test('missing pin disables confirmation and preserves feedback access',async()=>{detail.pin=null;await open();expect(button('Confirm location').disabled).toBe(true);await click('Give feedback');expect(el.querySelector('textarea')).not.toBeNull();expect(el.querySelector('a[href]')).toBeNull();expect(el.querySelector('iframe')).toBeNull();});
test('failed save keeps description and retries same request without duplicate evidence',async()=>{await open();await click('Give feedback');await fill(el.querySelector('select'),'missing_information');await fill(el.querySelector('textarea'),'Need apartment number');api.post.mockRejectedValueOnce(new Error('Connection lost'));const submit=()=>act(async()=>el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await submit();const original=api.post.mock.calls[0][1];expect(el.querySelector('textarea').value).toBe('Need apartment number');await submit();expect(api.post.mock.calls[1][1]).toEqual(original);expect(el.textContent).toContain('Feedback saved.');});
test('count failure shows unavailable, never a false zero',async()=>{api.get.mockRejectedValue(new Error('Source unavailable'));await act(async()=>root.unmount());root=createRoot(el);await act(async()=>root.render(<DispatcherNewCustomers/>));expect(button('New customer, count unavailable')).toBeDefined();expect(el.textContent).toContain('New customer count unavailable');});

test('driver completion automatically removes a customer from the list and notification count',async()=>{
 const handlers=new Map();mockSocket={on:jest.fn((name,handler)=>handlers.set(name,handler)),off:jest.fn()};
 await act(async()=>root.render(<DispatcherNewCustomers/>));await open();
 // Return to the list; a customer detail remains read-only until its next server validation.
 await click('← Back to new customers');
 api.get.mockImplementation(async()=>({data:{data:{count:0,rows:[],pages:0}}}));
 jest.useFakeTimers();
 try{
  await act(async()=>{handlers.get('delivery:statusUpdate')({status:'delivered'});jest.advanceTimersByTime(351);});
  expect(button('New customer, 0')).toBeDefined();expect(el.querySelectorAll('.dp-new-customer-list button')).toHaveLength(0);expect(el.textContent).toContain('No new customers with an upcoming first delivery');
  await act(async()=>root.render(null));expect(mockSocket.off).toHaveBeenCalledWith('delivery:statusUpdate',expect.any(Function));
 }finally{jest.useRealTimers();}
});
test('completion on the final page clamps the customer list to a remaining valid page',async()=>{
 const handlers=new Map();mockSocket={on:jest.fn((name,handler)=>handlers.set(name,handler)),off:jest.fn()};
 await act(async()=>root.render(<DispatcherNewCustomers/>));await click('New customer, 1');await click('Next');
 expect(el.textContent).toContain('Page 2 / 2');
 api.get.mockImplementation(async()=>({data:{data:{count:1,rows:[detail],pages:1}}}));
 jest.useFakeTimers();
 try{await act(async()=>{handlers.get('delivery:statusUpdate')({status:'delivered'});jest.advanceTimersByTime(351);});expect(el.textContent).toContain('Page 1 / 1');expect(el.querySelectorAll('.dp-new-customer-list button')).toHaveLength(1);}finally{jest.useRealTimers();}
});

test('an older badge request cannot restore a customer after a driver completion refresh',async()=>{
 await act(async()=>root.render(null));
 const handlers=new Map();mockSocket={on:jest.fn((name,handler)=>handlers.set(name,handler)),off:jest.fn()};
 let resolveOld;
 api.get.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValue({data:{data:{count:0,rows:[],pages:0}}});
 await act(async()=>root.render(<DispatcherNewCustomers/>));
 jest.useFakeTimers();
 try{
  await act(async()=>{handlers.get('delivery:statusUpdate')({status:'delivered'});jest.advanceTimersByTime(351);});
  expect(button('New customer, 0')).toBeDefined();
  await act(async()=>resolveOld({data:{data:{count:1}}}));expect(button('New customer, 0')).toBeDefined();
 }finally{jest.useRealTimers();}
});
