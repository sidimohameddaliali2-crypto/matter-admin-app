import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import BagFollowups,{csvCell} from './BagFollowups';
import api from '../../utils/api';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let data,root,container;
const button=text=>[...container.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
async function click(text){expect(button(text)).toBeDefined();await act(async()=>button(text).click());}
async function fill(el,value){await act(async()=>{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
beforeEach(async()=>{
  data={rows:[{customerId:'C1',customerName:'Sample Customer',outstandingBagIds:['BAG-0001','BAG-0002'],outstanding:2,confirmed:2,collected:0,ambiguous:0,flagged:true,flagType:'two_bags',overdueBags:[],cycleKey:'a'.repeat(64),version:0,ownerId:'',ownerName:'Unassigned',ownerActive:false,status:'open',reminderDue:true,nextDueAt:null,lastContactAt:null,followup:null}],owners:[{_id:'staff',name:'Responsible Person'}],report:{twoBagCustomers:1,dueFollowups:1,unassigned:1,overdueReturnCustomers:0,owners:[],driverReceipts:[],refunds:{inReview:0,approvedAwaitingCompletion:0,approvedAmountMinor:0},generatedAt:'2026-10-22T08:00:00Z'}};
  api.get.mockReset();api.post.mockReset();api.get.mockImplementation(async()=>({data:{data}}));api.post.mockResolvedValue({data:{success:true}});
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);await act(async()=>root.render(<BagFollowups/>));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
test('two-bag reminders load without creating tasks or sending messages',()=>{
  expect(api.get).toHaveBeenCalledWith('/bag-followups');expect(api.post).not.toHaveBeenCalled();expect(container.textContent).toContain('2+ bags · follow up');expect(container.textContent).toContain('Internal staff reminders');
});
test('owner and Dubai reminder time are submitted with custody and optimistic versions',async()=>{
  await click('Manage follow-up');await fill(container.querySelector('.bo-detail-grid select'),'staff');await fill(container.querySelector('input[type="datetime-local"]'),'2026-10-23T09:00');await fill(container.querySelector('textarea'),'Check pickup tomorrow morning');await click('Save internal reminder');
  expect(api.post).toHaveBeenCalledWith('/bag-followups',expect.objectContaining({ownerId:'staff',customerId:'C1',version:0,cycleKey:'a'.repeat(64),nextDueAt:'2026-10-23T05:00:00.000Z',contactChannel:null}));expect(container.textContent).toContain('No customer message was sent');
});
test('logging actual contact requires a channel and explicit confirmation',async()=>{
  await click('Manage follow-up');await fill(container.querySelector('textarea'),'Called to confirm collection');
  const selects=container.querySelectorAll('section[aria-label="Customer bag follow-up"] select');await fill(selects[1],'contacted');expect(button('Save internal reminder').disabled).toBe(true);await fill(selects[2],'phone');expect(button('Save internal reminder').disabled).toBe(true);await act(async()=>container.querySelector('input[type="checkbox"]').click());await click('Save internal reminder');
  expect(api.post).toHaveBeenCalledWith('/bag-followups',expect.objectContaining({status:'contacted',contactChannel:'phone',confirmedContact:true}));
});
test('failed updates remain visible beside the form and retries retain the same request ID',async()=>{
  api.post.mockRejectedValue({response:{data:{message:'Custody changed. Refresh first.'}}});await click('Manage follow-up');await fill(container.querySelector('textarea'),'Verify current tags');await click('Save internal reminder');expect(container.querySelector('[role="alert"]').textContent).toContain('Custody changed');const eventId=api.post.mock.calls[0][1].eventId;await click('Save internal reminder');expect(api.post.mock.calls[1][1].eventId).toBe(eventId);
});
test('legacy two-bag associations show a verification warning instead of confirmed debt',async()=>{
  data.rows[0].ambiguous=2;data.rows[0].confirmed=0;await click('Refresh reminders');expect(container.textContent).toContain('2+ recorded · verify custody');await click('Manage follow-up');expect(container.textContent).toContain('Verify physical custody before asking this customer');
});
test('CSV cells neutralize formulas, control prefixes, quotes and multiline values',()=>{
  expect(csvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');expect(csvCell('  =1+1')).toBe('"\'  =1+1"');expect(csvCell('Normal, name')).toBe('"Normal, name"');expect(csvCell('\n=1+1')).toBe('"\'\n=1+1"');
});
