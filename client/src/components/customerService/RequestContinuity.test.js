import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import RequestActionForm from './RequestActionForm';
import RequestWork from './RequestWork';
import OutcomeEvidence from './OutcomeEvidence';
import api from '../../utils/api';
import {REQUEST_TOPIC_TAGS} from '../../../../server/config/customerServiceTopicTags';
import {TOPIC_ACTIONS,ACTION_VERSION} from '../../../../server/config/customerServiceActions';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
const definitions={topics:REQUEST_TOPIC_TAGS,actions:TOPIC_ACTIONS,actionVersion:ACTION_VERSION};
const saved={_id:'one',conversationId:'chat',version:1,canWork:true,status:'waiting',workflowDefinitionVersion:ACTION_VERSION,title:'Missed delivery',classification:{kind:'complaint',topic:'tag_delivery',subtopic:'missed_delivery'},ownerId:'staff',topicDetails:{reference:'QA-ORDER',deliveryDate:'2026-11-10'},nextAction:{action:'Saved check with Delivery',dueAt:'2026-11-11T06:00:00Z'},waitingOn:'Delivery',history:[],followups:[],exceptions:[]};
const reply={_id:'reply',authorType:'staff',text:'The agreed day credit is posted',sentAt:'2026-11-10T07:00:00Z'};
const base={request:saved,definitions,owners:[{userId:'staff',displayName:'QA staff'}],actorId:'staff',conversationId:'chat',messages:[reply],capabilities:{sidebarSandbox:true,assignRequests:true,closeSensitive:true},qaState:{practice:{detail:'missed_delivery',delivery_date:'2026-11-10',order_reference:'QA-ORDER'}},onSaved:jest.fn()};
const wrap=data=>({data:{data}});let root,el;
beforeEach(()=>{jest.clearAllMocks();sessionStorage.clear();el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();sessionStorage.clear();});
const render=ui=>act(async()=>root.render(ui));
const click=text=>act(async()=>{const b=[...el.querySelectorAll('button')].find(b=>b.textContent===text);if(!b)throw Error('Missing button '+text);b.click();});
const change=(label,value)=>act(async()=>{const e=el.querySelector(`[aria-label="${label}"]`);if(!e)throw Error('Missing field '+label);if(e.tagName==='SELECT'){e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));}else{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));}});
const save=()=>act(async()=>el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
const value=label=>el.querySelector(`[aria-label="${label}"]`)?.value;

test('action switches retain separate text, dates, conditional input and evidence through failure and reload',async()=>{
 await render(<RequestActionForm {...base}/>);await click('Update');expect(value('What happens next?')).toBe('Saved check with Delivery');
 await change('What happens next?','Draft update');await change('Check again · Dubai','2026-11-11T10:00');await change('Delivery date','2026-11-12');
 await click('Follow up');expect(value('What happens next?')).toBe('Draft update');await change('What happens next?','Draft follow-up');await change('Check again · Dubai','2026-11-11T11:00');await change('Customer update promised · Dubai','2026-11-11T11:30');
 await click('Resolve');await change('What happened?','complete:day_credit_applied');await change('Credit record reference','QA-CREDIT');await act(async()=>el.querySelector('[aria-label="Customer informed"]').click());await change('Outcome evidence message','reply');
 await click('Update');expect(value('What happens next?')).toBe('Draft update');expect(value('Check again · Dubai')).toBe('2026-11-11T10:00');expect(value('Delivery date')).toBe('2026-11-12');
 await click('Follow up');expect(value('What happens next?')).toBe('Draft follow-up');expect(value('Check again · Dubai')).toBe('2026-11-11T11:00');expect(value('Customer update promised · Dubai')).toBe('2026-11-11T11:30');
 await click('Resolve');expect(value('Credit record reference')).toBe('QA-CREDIT');expect(value('Outcome evidence message')).toBe('reply');expect(el.querySelector('[aria-label="Customer informed"]').checked).toBe(true);
 api.post.mockRejectedValueOnce({response:{status:503,data:{message:'Interrupted save'}}});await save();const first=api.post.mock.calls[0][1];expect(el.textContent).toContain('Your draft is kept');
 await act(async()=>root.unmount());root=createRoot(el);await render(<RequestActionForm {...base}/>);expect(value('Outcome evidence message')).toBe('reply');expect(value('Credit record reference')).toBe('QA-CREDIT');
 api.post.mockResolvedValueOnce(wrap({...saved,status:'resolved',version:2}));await save();expect(api.post.mock.calls[1][1]).toEqual(first);expect(sessionStorage.getItem('matter:action-draft:staff:chat:one')).toBeNull();
});
test('selecting one QA issue detail opens its next-action editor, retains the permitted owner and saves both taxonomy IDs',async()=>{
 await render(<RequestActionForm {...base} request={null} conversationScope suggestedOwnerId="staff"/>);
 expect(el.querySelector('[aria-label="Inquiry"]').checked).toBe(true);expect(el.querySelector('[aria-label="Topic"]')).toBeNull();expect(el.querySelector('[aria-label="Issue detail"]')).toBeNull();
 await change('Choose issue','Missed Delivery');await click('Missed Delivery');expect(value('What happens next?')).toBe('Check delivery');expect(el.querySelector('button.cs-primary').textContent).toBe('Save update');
 expect([...el.querySelector('[aria-label="Update action"]').options].map(o=>o.value)).not.toContain('team');
 await change('What happens next?','Ask Delivery to verify the order');await change('Check again · Dubai','2026-11-11T10:00');api.post.mockResolvedValueOnce(wrap({...saved,version:1}));await save();
 expect(api.post.mock.calls[0][1]).toMatchObject({classification:{kind:'inquiry',topic:'tag_delivery',subtopic:'missed_delivery'},ownerId:'staff',actionCode:'check',nextAction:'Ask Delivery to verify the order',dueAt:'2026-11-11T06:00:00.000Z'});
});
test('team-specific follow-up stays available once in Follow up, without duplicating it in Update',async()=>{
 await render(<RequestActionForm {...base}/>);await click('Follow up');expect([...el.querySelector('[aria-label="Follow-up type"]').options].map(o=>o.value)).toContain('team');await change('Follow-up type','team');await change('What happens next?','Ask Delivery for acknowledgement');api.post.mockRejectedValueOnce(Error('Keep draft'));await save();expect(api.post.mock.calls[0][1].actionCode).toBe('team');
});
test('an explicitly selected customer follow-up supplies the exact reopen message while keeping the reason mandatory',async()=>{
 const customer={_id:'followup-exact',conversationId:'chat',authorType:'customer',text:'Please check again',sentAt:'2026-11-10T09:00Z'};
 await render(<RequestActionForm {...base} request={{...saved,status:'resolved',customerUpdateDueAt:'2026-11-11T06:30:00Z'}} reopen reopenMessage={customer} messages={[reply,customer]}/>);
 expect(value('Related customer message')).toBe('followup-exact');expect(el.querySelector('[aria-label="Why reopen this issue?"]').required).toBe(true);
 await change('Why reopen this issue?','The customer reports the credit did not reach their account');await click('Follow up');expect(value('Customer update promised · Dubai')).toBe('');await change('What happens next?','Verify the credit record');api.post.mockResolvedValueOnce(wrap({...saved,status:'open',version:2}));await save();expect(api.post.mock.calls[0][1]).toMatchObject({reopen:true,reopenMessageId:'followup-exact',reopenReason:'The customer reports the credit did not reach their account',customerUpdateDueAt:null});
});
test('a reopen reason survives reload before an action is chosen and stays separate from an earlier recording draft',async()=>{
 const closed={...saved,status:'resolved'},customer={_id:'new-customer-message',authorType:'customer',text:'It is still missing'};
 sessionStorage.setItem('matter:action-draft:staff:chat:one',JSON.stringify({fields:{uiMode:'resolve',actionCode:'complete',outcomeCode:'day_credit_applied',topic:'tag_delivery',subtopic:'missed_delivery',details:{creditReference:'Prior recording draft'}},version:1,commandKey:'original-recording-key'}));
 await render(<RequestActionForm {...base} request={closed} reopen reopenMessage={customer} messages={[customer]}/>);await change('Why reopen this issue?','The customer asks for another check');expect(sessionStorage.getItem('matter:action-draft:staff:chat:one:reopen')).toContain('The customer asks for another check');
 await act(async()=>root.unmount());root=createRoot(el);await render(<RequestActionForm {...base} request={closed} reopen messages={[customer]}/>);expect(value('Why reopen this issue?')).toBe('The customer asks for another check');expect(value('Related customer message')).toBe('new-customer-message');expect(sessionStorage.getItem('matter:action-draft:staff:chat:one')).toContain('Prior recording draft');expect(api.post).not.toHaveBeenCalled();
});
test('a reopened issue keeps the previous outcome, exact reply excerpt, reference, actor and time',async()=>{
 const view=jest.fn();await render(<OutcomeEvidence request={{...saved,status:'open',resolution:{outcomeLabel:'Day credit applied',evidenceMessageId:'reply',evidenceReference:'QA-CREDIT',at:'2026-11-10T07:00Z',actorId:'staff'}}} definitions={definitions} owners={base.owners} messages={[reply]} onViewMessage={view}/>);
 expect(el.querySelector('[aria-label="Previous outcome evidence"]')).not.toBeNull();expect(el.textContent).toContain('Issue reopened');expect(el.textContent).toContain(reply.text);expect(el.textContent).toContain('QA-CREDIT');expect(el.textContent).toContain('QA staff');expect(el.textContent).toContain('10 Nov 2026, 11:00');await click('View message');expect(view).toHaveBeenCalledWith('reply');
});
test('sibling switching is one click, preserves separate drafts and resumes the selected issue after reload',async()=>{
 const second={...saved,_id:'two',title:'Second issue',nextAction:{action:'Saved second check',dueAt:'2026-11-12T06:00Z'}};
 api.get.mockImplementation(async(url,options={})=>wrap(url.endsWith('/definitions')?definitions:{requests:options.params?.requestId?[saved,second].filter(r=>r._id===options.params.requestId):[saved,second],statusCounts:{open:2,resolved:0,non_customer:0}}));
 const props={conversationId:'chat',capabilities:base.capabilities,owners:base.owners,actorId:'staff',onSaved:jest.fn(),messages:[reply],onOverviewChange:jest.fn()};
 await render(<RequestWork {...props} requestId="one"/>);await click('Follow up');await change('What happens next?','Keep first draft');
 const choose=title=>act(async()=>[...el.querySelectorAll('.cs-issue-overview button')].find(b=>b.textContent.includes(title)).click());
 await choose('Second issue');expect(el.querySelector('.cs-current-issue').textContent).toContain('Second issue');expect(el.querySelector('.cs-issue-overview').textContent).toContain('Draft');await click('Follow up');await change('What happens next?','Keep second draft');
 await choose('Missed delivery');expect(value('What happens next?')).toBe('Keep first draft');await choose('Second issue');expect(value('What happens next?')).toBe('Keep second draft');
 await act(async()=>root.unmount());root=createRoot(el);await render(<RequestWork {...props}/>);expect(el.querySelector('.cs-current-issue').textContent).toContain('Second issue');expect(value('What happens next?')).toBe('Keep second draft');expect(el.querySelectorAll('.cs-issue-overview em')).toHaveLength(1);expect(sessionStorage.getItem('matter:action-draft:staff:chat:one')).toContain('Keep first draft');expect(sessionStorage.getItem('matter:action-draft:staff:chat:two')).toContain('Keep second draft');expect(api.post).not.toHaveBeenCalled();
});

test('other issues sit below active actions and disappear while adding or resuming a new issue',async()=>{
 const second={...saved,_id:'two',title:'Bag collection'};
 api.get.mockImplementation(async(url,options={})=>wrap(url.endsWith('/definitions')?definitions:{requests:options.params?.requestId?[saved,second].filter(r=>r._id===options.params.requestId):[saved,second],statusCounts:{open:2,resolved:0,non_customer:0}}));
 const overview=jest.fn(),panelRef=React.createRef(),props={conversationId:'chat',capabilities:base.capabilities,owners:base.owners,actorId:'staff',onSaved:jest.fn(),messages:[reply],onOverviewChange:overview,panelRef};
 await render(<RequestWork {...props} requestId="one"/>);
 const other=el.querySelector('.cs-issue-overview');expect(other.textContent).toContain('Other issues in this conversation');expect(other.textContent).toContain('Bag collection');expect(other.textContent).not.toContain('Missed delivery');expect(el.querySelectorAll('.cs-issue-overview button')).toHaveLength(1);expect(el.querySelector('.cs-topic-action').compareDocumentPosition(other)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 await act(async()=>other.querySelector('button').click());expect(el.querySelector('.cs-current-issue').textContent).toContain('Bag collection');expect(document.activeElement).toBe(panelRef.current);
 await click('+ Add issue');expect(el.querySelector('.cs-work-heading h3').textContent).toBe('New issue');expect(el.querySelector('.cs-issue-overview')).toBeNull();expect(el.querySelector('.cs-current-issue')).toBeNull();expect(overview.mock.calls.at(-1)[0].adding).toBe(true);
 await change('Choose issue','Missed Delivery');await click('Missed Delivery');await change('What happens next?','Check this new delivery separately');
 await click('‹');expect(el.querySelector('.cs-work-heading h3').textContent).toBe('Issues');expect(el.textContent).toContain('Resume issue draft');await click('Resume issue draft');expect(value('What happens next?')).toBe('Check this new delivery separately');expect(el.querySelector('.cs-issue-overview')).toBeNull();expect(api.post).not.toHaveBeenCalled();
});
