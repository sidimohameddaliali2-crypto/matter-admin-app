import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import BagRefundTracker from './BagRefundTracker';
import api from '../../utils/api';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
const candidate=()=>({customerId:'C1',customerName:'Sample Customer',amountMinor:15500,bags:[{bagId:'BAG-0001',returnKey:'b1:collect-1',receiptEventId:null}]});
const record=(extra={})=>({_id:'case1',customerId:'C1',customerName:'Sample Customer',amountMinor:15500,status:'review',active:true,version:4,endEvidence:'Subscription ended; unpaid deposit confirmed',createdAt:'2026-10-22T06:00:00Z',history:[],eligibility:{stage:'ready_for_approval',eligible:true,damaged:false,blockers:[],items:[{bagId:'BAG-0001',returnKey:'b1:collect-1',receiptEventId:'receipt-1',receivedAt:'2026-10-22T07:00:00Z',inspection:null}]},...extra});
let root,container,data;
const button=text=>[...container.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
const click=async text=>{expect(button(text)).toBeDefined();await act(async()=>button(text).click());};
const fill=async(el,value)=>{await act(async()=>{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});};
async function render(){await act(async()=>root.render(<BagRefundTracker/>));}
beforeEach(()=>{
  api.get.mockReset();api.post.mockReset();data={canApprove:true,candidates:[candidate()],cases:[]};
  api.get.mockImplementation(async()=>({data:{data}}));api.post.mockResolvedValue({data:{success:true}});
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
test('collection queue shows AED 155 for review without creating a refund',async()=>{
  await render();expect(api.get).toHaveBeenCalledWith('/bag-refunds');expect(api.post).not.toHaveBeenCalled();expect(container.textContent).toContain('awaiting warehouse');expect(container.textContent).toContain('155');
});
test('final-return case requires both confirmations and preserves a stable request ID',async()=>{
  await render();await click('Review return');expect(button('Open AED 155 refund case').disabled).toBe(true);
  await act(async()=>{for(const input of container.querySelectorAll('input[type="checkbox"]'))input.click();});
  await fill(container.querySelector('textarea'),'Verified subscription end and outstanding deposit');await click('Open AED 155 refund case');
  expect(api.post).toHaveBeenCalledWith('/bag-refunds',expect.objectContaining({customerId:'C1',confirmedFinalReturn:true,confirmedDepositDue:true,dismiss:false,requestId:expect.any(String)}));
});
test('warehouse can record receipt inspection but cannot approve a refund',async()=>{
  data={canApprove:false,candidates:[],cases:[record()]};await render();await click('Open refund case');expect(button('Approve AED 155 refund')).toBeUndefined();
  await click('Record inspection · BAG-0001');await act(async()=>container.querySelector('input[type="checkbox"]').click());await fill(container.querySelector('textarea'),'Inspected exact returned tag');await click('Confirm tracker update');
  expect(api.post).toHaveBeenCalledWith('/bag-refunds/case1/actions',expect.objectContaining({action:'inspect',version:4,returnKey:'b1:collect-1',confirmed:true,outcome:'good'}));
});
test('damage approval requires explicit acknowledgement of the full refund',async()=>{
  const c=record();c.eligibility.damaged=true;data={canApprove:true,candidates:[],cases:[c]};await render();await click('Open refund case');await click('Approve AED 155 refund');await fill(container.querySelector('textarea'),'Damage reviewed, full deposit refund');expect(button('Confirm tracker update').disabled).toBe(true);
  await act(async()=>container.querySelector('input[type="checkbox"]').click());await click('Confirm tracker update');expect(api.post).toHaveBeenCalledWith('/bag-refunds/case1/actions',expect.objectContaining({action:'approve',acknowledgeDamage:true}));
});
test('completion records Dubai time and leaves a failed case pending for retry',async()=>{
  data={canApprove:true,candidates:[],cases:[record({status:'approved'})]};api.post.mockRejectedValue({response:{data:{message:'Case changed; refresh'}}});await render();await click('Open refund case');await click('Record refund completed');
  await fill(container.querySelector('input[type="datetime-local"]'),'2026-10-22T12:30');await fill(container.querySelector('textarea'),'Confirmed by finance');await act(async()=>container.querySelector('input[type="checkbox"]').click());await click('Confirm tracker update');
  expect(api.post).toHaveBeenCalledWith('/bag-refunds/case1/actions',expect.objectContaining({action:'complete',completedAt:'2026-10-22T08:30:00.000Z',confirmed:true,version:4}));expect(container.querySelector('[role="alert"]').textContent).toContain('Case changed');expect(button('Confirm tracker update')).toBeDefined();
  const requestId=api.post.mock.calls[0][1].eventId;await click('Confirm tracker update');expect(api.post.mock.calls[1][1].eventId).toBe(requestId);
});
test('closed cases show completion evidence and have no approval or completion controls',async()=>{
  data={canApprove:true,candidates:[],cases:[record({status:'completed',active:false,completion:{completedAt:'2026-10-22T10:00:00Z',reference:'Refund reference 12',note:'Verified by finance'}})]};await render();await click('Open refund case');expect(container.textContent).toContain('Refund reference 12');expect(button('Approve AED 155 refund')).toBeUndefined();expect(button('Record refund completed')).toBeUndefined();
});
