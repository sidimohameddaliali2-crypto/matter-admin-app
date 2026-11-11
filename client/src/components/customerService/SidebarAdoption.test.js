import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import RequestActionForm from './RequestActionForm';
import RequestWork from './RequestWork';
import CustomerSummary from './CustomerSummary';
import api from '../../utils/api';
import {REQUEST_TOPIC_TAGS} from '../../../../server/config/customerServiceTopicTags';
import {TOPIC_ACTIONS,ACTION_VERSION} from '../../../../server/config/customerServiceActions';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
const definitions={topics:REQUEST_TOPIC_TAGS,actions:TOPIC_ACTIONS,actionVersion:ACTION_VERSION,nonCustomerTypes:{available:true},issuePicker:{available:true}};
const request={_id:'issue',conversationId:'chat',version:1,canWork:true,status:'waiting',classification:{kind:'complaint',topic:'tag_delivery',subtopic:'missed_delivery'},ownerId:'staff',history:[],followups:[],exceptions:[],nextAction:{action:'Check Delivery',dueAt:'2026-11-12T06:00:00Z'},customerUpdateDueAt:'2026-11-12T06:30:00Z'};
const props={request,definitions,owners:[{userId:'staff',displayName:'Staff'}],actorId:'staff',conversationId:'chat',capabilities:{assignRequests:true},onSaved:jest.fn()};
const wrap=data=>({data:{data}});
let root,el;
beforeEach(()=>{jest.clearAllMocks();sessionStorage.clear();el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();sessionStorage.clear();});
const render=ui=>act(async()=>root.render(ui));
const click=text=>act(async()=>{const button=[...el.querySelectorAll('button')].find(b=>b.textContent===text);if(!button)throw Error('Missing button '+text);button.click();});
const submit=()=>act(async()=>el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));

test('the normal staff surface uses the approved searchable picker without enabling QA controls',async()=>{
 await render(<RequestActionForm {...props} request={null} conversationScope suggestedOwnerId="staff"/>);
 expect(el.querySelector('[aria-label="Choose issue"]')).not.toBeNull();
 expect(el.querySelector('[aria-label="Topic"]')).toBeNull();
 expect([...el.querySelectorAll('[aria-label="Type"] button')].map(b=>b.textContent)).toEqual(['Complaint','Inquiry','Spam / Vendor']);
 expect(el.textContent).not.toContain('QA');expect(api.post).not.toHaveBeenCalled();
});
test('normal staff follow-up keeps the customer promise separate and saves both Dubai times as UTC',async()=>{
 await render(<RequestActionForm {...props}/>);await click('Follow up');
 expect(el.querySelector('[aria-label="Customer update promised · Dubai"]')?.value).toBe('2026-11-12T10:30');
 api.post.mockResolvedValueOnce(wrap({...request,version:2}));await submit();
 expect(api.post.mock.calls[0][1]).toMatchObject({dueAt:'2026-11-12T06:00:00.000Z',customerUpdateDueAt:'2026-11-12T06:30:00.000Z'});
});
test('saving an ordinary update cannot move an existing customer promise by four hours',async()=>{
 await render(<RequestActionForm {...props}/>);await click('Update');
 api.post.mockResolvedValueOnce(wrap({...request,version:2}));await submit();
 expect(api.post.mock.calls[0][1].customerUpdateDueAt).toBe('2026-11-12T06:30:00.000Z');
});
test('a delivery simulation is not presented as acknowledgement for a bag issue in the same chat',async()=>{
 const bag={...request,classification:{kind:'complaint',topic:'tag_bags',subtopic:'bag_not_collected'},title:'Bag not collected'};
 api.get.mockImplementation(async url=>wrap(url.endsWith('/definitions')?definitions:url.endsWith('/sandbox/state')?{practice:{detail:'missed_delivery'},events:[{kind:'delivery_acknowledged'}]}:{requests:[bag],statusCounts:{open:1,resolved:0,non_customer:0}}));
 await render(<RequestWork conversationId="chat" requestId="issue" capabilities={{sidebarSandbox:true,assignRequests:true}} owners={props.owners} actorId="staff" onSaved={jest.fn()}/>);
 expect(el.querySelector('.cs-current-issue').textContent).toContain('Bag not collected');
 expect(el.querySelector('.cs-handoff-status')).toBeNull();
});
test('a closed source chat never claims the customer issue was resolved',async()=>{
 api.get.mockResolvedValueOnce(wrap({customer:{name:'Captured account'},issues:[{_id:'prior',conversationId:'prior-chat',conversationHistory:{closedAt:'2026-11-10T07:00Z'}}]}));
 await render(<CustomerSummary conversation={{_id:'chat',customerId:'linked-account'}}/>);
 expect(el.textContent).toContain('Previous: Conversation · Chat closed');
 expect(el.textContent).not.toContain('Resolved');
});
