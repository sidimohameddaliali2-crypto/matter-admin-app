import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import Customers from './Customers';
import api from '../../utils/api';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,container;
const issue={_id:'issue1',conversationId:'conversation1',summary:'Source issue',categoryIds:[],outcome:'unknown'};
const record={key:'matter:123',customerId:'matter:123',name:'Directory customer',source:'matter_directory',sourceObservedAt:'2026-11-06T06:00:00Z',matchState:'verified_phone',issues:[issue],subscriptions:[{subscriptionId:'plan1',planName:'Balanced',status:'active',startDate:'2026-11-01',endDate:'2026-11-30'}]};
const directory=(extra={})=>({records:[record],total:121,page:1,pageSize:50,counts:{directoryCustomers:121,linkedCustomers:1,unmatchedContacts:17,unmatchedConversations:1520},source:{state:'available',coverage:'partial',message:'Read-only Matter snapshot.',observedAt:'2026-11-06T06:00:00Z'},...extra});
const respond=data=>({data:{data}});
const button=name=>[...container.querySelectorAll('button')].find(el=>el.textContent===name);
const render=props=>act(async()=>root.render(<Customers filters={{}} categories={[]} capabilities={{supervise:true}} {...props}/>));
beforeEach(()=>{jest.clearAllMocks();container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);api.get.mockResolvedValue(respond(directory()));});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
test('directory total is separate from unmatched conversations and shows subscriptions',async()=>{
 await render();expect(api.get).toHaveBeenCalledWith('/customer-service/customers',{params:{view:'customers',page:1,pageSize:50}});
 expect(container.textContent).toContain('121 customers in this scope');expect(container.textContent).not.toContain('1,520 customers');expect(container.textContent).toContain('1,520');expect(container.textContent).toContain('Balanced');expect(container.textContent).toContain('Start 1 Nov 2026 · End 30 Nov 2026');expect(container.textContent).toContain('Coverage: partial');expect(button('Previous page').disabled).toBe(true);
});
test('pagination preserves filters and changed search returns to page one',async()=>{
 api.get.mockImplementation(async(url,{params})=>respond(directory({page:params.page})));
 const filters={search:'source query',from:'2026-11-01',to:'2026-11-06',categoryId:'delivery'};await render({filters});await act(async()=>button('Next page').click());
 expect(api.get).toHaveBeenLastCalledWith('/customer-service/customers',{params:{q:'source query',from:'2026-11-01',to:'2026-11-06',categoryId:'delivery',view:'customers',page:2,pageSize:50}});expect(container.textContent).toContain('Page 2 of 3');
 await render({filters:{...filters,search:'changed'}});expect(api.get).toHaveBeenLastCalledWith('/customer-service/customers',expect.objectContaining({params:expect.objectContaining({q:'changed',page:1})}));
});
test('failed refresh retains saved directory and source failure can be retried',async()=>{
 await render({epoch:0});api.get.mockRejectedValueOnce(new Error('Matter source unavailable'));await render({epoch:1});expect(container.querySelector('[role="alert"]').textContent).toContain('Matter source unavailable');expect(container.textContent).toContain('Directory customer');
 api.get.mockResolvedValueOnce(respond(directory({source:{state:'unavailable',coverage:'partial',message:'Saved snapshot; source refresh failed.'}})));await act(async()=>button('Retry customer directory').click());expect(container.textContent).toContain('Saved snapshot; source refresh failed.');expect(container.querySelector('[role="alert"]')).toBeNull();
});
test('unmatched contact chats remain accessible without requesting Matter context',async()=>{
 api.get.mockImplementation(async(url,{params}={})=>{
  if(url==='/customer-service/issues/issue1')return respond({issue,messages:[{_id:'message1',type:'text',text:'Recorded chat evidence',authorType:'customer'}],reviews:[]});
  return respond(params?.view==='unmatched'?directory({records:[{key:'contact:1',customerId:'',name:'Recorded contact',source:'gallabox',matchState:'unmatched',issues:[issue]}],total:17}):directory());
 });
 await render();await act(async()=>button('Unmatched conversations').click());expect(api.get).toHaveBeenLastCalledWith('/customer-service/customers',expect.objectContaining({params:expect.objectContaining({view:'unmatched',page:1})}));expect(container.textContent).toContain('17 unmatched contact groups in this scope');expect(container.textContent).not.toContain('Balanced');
 await act(async()=>button('View captured chats').click());expect(container.querySelector('[role="dialog"]').textContent).toContain('No identity is guessed');expect(api.get.mock.calls.some(([url])=>url.endsWith('/context'))).toBe(false);await act(async()=>button('View conversation').click());expect(container.textContent).toContain('Recorded chat evidence');
});
test('encoded Matter IDs support multiple subscriptions and legacy context',async()=>{
 api.get.mockImplementation(async url=>respond(url.endsWith('/context')?{customer:{name:'Confirmed directory name'},subscriptions:[record.subscriptions[0],{subscriptionId:'plan2',planName:'Previous plan',status:'expired'}],source:{state:'available',observedAt:'2026-11-06T06:00:00Z'}}:directory()));
 await render();await act(async()=>button('View customer').click());expect(api.get).toHaveBeenCalledWith('/customer-service/customers/matter%3A123/context',{params:{}});expect(container.querySelector('[role="dialog"]').textContent).toContain('Previous plan');await act(async()=>container.querySelector('[aria-label="Close customer context"]').click());
 api.get.mockResolvedValueOnce(respond({customer:{name:'Legacy context'},subscription:{name:'Legacy plan',subscriptionStatus:'paused'},sourceState:'available'}));await act(async()=>button('View customer').click());expect(container.querySelector('[role="dialog"]').textContent).toContain('Legacy plan');expect(container.querySelector('[role="dialog"]').textContent).toContain('paused');
});
test('customer context keeps the selected date range and uses its filtered chat list',async()=>{
 api.get.mockImplementation(async url=>respond(url.endsWith('/context')?{customer:{name:'Directory customer'},subscriptions:record.subscriptions,issues:[],source:{state:'available'}}:directory()));
 await render({filters:{from:'2026-11-06',to:'2026-11-06'}});await act(async()=>button('View customer').click());
 expect(api.get).toHaveBeenCalledWith('/customer-service/customers/matter%3A123/context',{params:{from:'2026-11-06',to:'2026-11-06'}});expect(button('View conversation')).toBeUndefined();expect(container.querySelector('[role="dialog"]').textContent).toContain('Balanced');
});
test('partial refresh shows fresh API and retained database records without calling the whole source unavailable',async()=>{
 const source={state:'partial',message:'API updated · database unavailable',coverage:'partial',observedAt:'2026-11-06T06:00:00Z'};
 api.get.mockResolvedValue(respond(directory({source,total:2,records:[{...record,name:'Fresh API customer'},{...record,key:'remote:1',customerId:'remote:1',name:'Retained database customer'}]})));
 await render();expect(container.querySelector('.cs-notice').textContent).toBe(source.message);expect(container.textContent).toContain('Fresh API customer');expect(container.textContent).toContain('Retained database customer');expect(container.textContent).not.toContain('Saved data · source refresh unavailable.');
 api.get.mockResolvedValue(respond(directory({source,total:0,records:[]})));await render({epoch:1});expect(container.textContent).toContain('Try All time or change the dates.');expect(container.textContent).not.toContain('Source unavailable. Try again.');
});
test('partial customer context reports the API refresh and database limitation while preserving subscriptions',async()=>{
 const source={state:'partial',message:'API updated · database unavailable',observedAt:'2026-11-06T06:00:00Z'};
 api.get.mockImplementation(async url=>respond(url.endsWith('/context')?{customer:{name:'Directory customer'},subscriptions:record.subscriptions,source}:directory({source})));
 await render();await act(async()=>button('View customer').click());const dialog=container.querySelector('[role="dialog"]');expect(dialog.querySelector('.cs-notice').textContent).toBe(source.message);expect(dialog.textContent).toContain('Balanced');expect(dialog.textContent).not.toContain('Saved data · source unavailable.');
});
test('history groups placeholder issues by conversation and keeps the source preview without unknown issue labels',async()=>{
 const source={...issue,summary:'',conversationHistory:{source:'gallabox',lastMessageAt:'2026-11-10T08:00:00Z',messageCount:12,preview:{authorType:'customer',type:'text',text:'Please change my delivery address'}}};
 const sibling={...source,_id:'issue2'};
 api.get.mockImplementation(async url=>respond(url.endsWith('/context')?{customer:{name:'Directory customer'},issues:[source,sibling],source:{state:'available'}}:directory({records:[{...record,issues:[source,sibling]}]})));
 await render();expect(container.textContent).toContain('1 conversations');await act(async()=>button('View customer').click());
 const dialog=container.querySelector('[role="dialog"]');expect(dialog.textContent).toContain('Conversation history');expect(dialog.textContent).toContain('Please change my delivery address');expect(dialog.textContent).toContain('12 captured messages');expect(dialog.textContent).toContain('10 Nov 2026');expect(dialog.querySelectorAll('input[required],select[required],textarea[required]')).toHaveLength(0);
 expect(dialog.textContent).not.toContain('Captured issue');expect(dialog.textContent).not.toContain('Not determined');expect(dialog.textContent).not.toContain('unknown');expect([...dialog.querySelectorAll('button')].filter(b=>b.textContent==='View conversation')).toHaveLength(1);expect(dialog.textContent).toContain('Saved issue reviews (2)');
});
test('history detail failures can be retried and saved reviews remain accessible',async()=>{
 api.get.mockImplementation(async url=>{
  if(url.includes('/issues/'))throw new Error('Connection interrupted');
  return respond(url.endsWith('/context')?{customer:{name:'Directory customer'},issues:[issue],source:{state:'available'}}:directory());
 });
 await render();await act(async()=>button('View customer').click());await act(async()=>button('View conversation').click());expect(container.textContent).toContain('Connection interrupted');
 api.get.mockResolvedValueOnce(respond({issue,messages:[{_id:'msg',text:'Original source message',type:'text',authorType:'customer'}],reviews:[{_id:'review',revisions:[{summary:'Original saved review',verdict:'good',outcome:'unknown',at:'2026-11-01'}]}]}));
 await act(async()=>button('Retry conversation').click());expect(container.textContent).toContain('Original source message');expect(container.textContent).toContain('Original saved review');await act(async()=>button('‹ Back to conversation history').click());expect(button('View conversation')).toBeDefined();
});
test('customer history traps focus using visible controls and keeps keyboard position during refresh',async()=>{
 api.get.mockImplementation(async url=>respond(url.endsWith('/context')?{customer:{name:'Directory customer'},issues:[issue,{...issue,_id:'sibling'}],source:{state:'available'}}:directory()));
 await render();await act(async()=>button('View customer').click());const close=container.querySelector('[aria-label="Close customer context"]');expect(document.activeElement).toBe(close);
 const tab=shiftKey=>act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey,bubbles:true,cancelable:true})));
 await tab(true);expect(document.activeElement.textContent).toBe('Saved issue reviews (2)');const last=document.activeElement;
 await render({epoch:1});expect(document.activeElement).toBe(last);await tab(false);expect(document.activeElement).toBe(close);
 await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(container.querySelector('[role="dialog"]')).toBeNull();
});
