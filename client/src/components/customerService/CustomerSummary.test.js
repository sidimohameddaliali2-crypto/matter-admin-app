import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import CustomerSummary from './CustomerSummary';
import api from '../../utils/api';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,el;
beforeEach(()=>{jest.clearAllMocks();el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
test('customer, plan and previous outcome are visible without expansion; previous request opens its actual conversation',async()=>{
 const open=jest.fn();
 await act(async()=>root.render(<CustomerSummary conversation={{_id:'current',customerId:'must-not-fetch',customerName:'QA contact'}} qaMode qaContext={{source:'qa_fixture',customer:{name:'Aisha — QA'},subscriptions:[{planName:'Sample 2-meal plan',status:'active'}],previousRequests:[{conversationId:'previous',title:'Bag collection',outcome:'Collected',at:'2026-11-07T06:00:00Z'}]}} onOpenConversation={open}/>));
 expect(el.textContent).toContain('Aisha — QA');expect(el.textContent).toContain('Sample 2-meal plan');expect(el.textContent).toContain('active');expect(el.textContent).toContain('Previous: Bag collection · Collected');expect(el.querySelector('details')).toBeNull();expect(api.get).not.toHaveBeenCalled();
 await act(async()=>el.querySelector('button').click());expect(open).toHaveBeenCalledWith('previous');
});
test('an unlinked contact shows its known name without inventing a customer, plan or empty history card',async()=>{
 await act(async()=>root.render(<CustomerSummary conversation={{_id:'unlinked',customerName:'Captured contact'}}/>));
 expect(el.textContent).toBe('Captured contactAccount not linked');expect(el.querySelector('button')).toBeNull();expect(el.querySelector('details')).toBeNull();expect(api.get).not.toHaveBeenCalled();
});
test('switching customers cannot leave the previous account summary visible',async()=>{
 api.get.mockResolvedValueOnce({data:{data:{customer:{name:'First account'},subscriptions:[{planName:'First plan'}]}}});
 await act(async()=>root.render(<CustomerSummary conversation={{_id:'one',customerId:'one'}}/>));expect(el.textContent).toContain('First plan');
 let finish;api.get.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 await act(async()=>root.render(<CustomerSummary conversation={{_id:'two',customerId:'two',customerName:'Second contact'}}/>));expect(el.textContent).not.toContain('First account');expect(el.textContent).not.toContain('First plan');
 await act(async()=>finish({data:{data:{customer:{name:'Second account'},subscriptions:[]}}}));expect(el.textContent).toContain('Second account');
});
