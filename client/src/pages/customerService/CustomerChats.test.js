import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import CustomerChats from './CustomerChats';
import api from '../../utils/api';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),patch:jest.fn()}}));
jest.mock('react-router-dom',()=>({useLocation:()=>({pathname:'/customer-service/chats',search:''}),useNavigate:()=>jest.fn()}),{virtual:true});
let mockWorkProps;
jest.mock('../../components/customerService/RequestWork',()=>({__esModule:true,default:props=>{mockWorkProps=props;return null;},RequestQueues:()=>null}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,el;
const props={me:{profile:{userId:'staff'}},user:{_id:'staff'},capabilities:{review:true,workActions:true},categories:[],filters:{from:'2026-11-06',to:'2026-11-06',search:'',categoryId:''},epoch:0,onRefresh:jest.fn()};
const response=data=>({data:{data}});
const row=(id,name)=>({_id:id,customerName:name,lastMessageAt:'2026-11-06T10:00:00Z',lastMessage:{text:`Preview ${name}`}});
const message=(id,text,time)=>({_id:id,text,authorType:'customer',sentAt:`2026-11-06T${time}:00Z`});
const click=async text=>{const button=[...el.querySelectorAll('button')].find(b=>b.textContent.includes(text));expect(button).toBeTruthy();await act(async()=>button.click());};
beforeEach(()=>{jest.useFakeTimers();jest.clearAllMocks();el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();jest.useRealTimers();});
test('staff can browse unmapped native chats and paginate without claiming a review',async()=>{
 api.get.mockImplementation(async(url,{params}={})=>response(url.endsWith('/conversations')?{conversations:params.cursor?[row('b','Second contact')]:[row('a','Unmapped contact')],nextCursor:params.cursor?null:'page2',hasMore:!params.cursor}:{conversation:row('a','Unmapped contact'),messages:[message('m','Customer question','10:00')],issues:[],actions:[]}));
 await act(async()=>root.render(<CustomerChats {...props}/>));
 expect(el.textContent).toContain('Unmapped contact');expect(el.textContent).not.toContain('Your next review');
 await click('Load more conversations');expect(el.textContent).toContain('Second contact');
 await click('Unmapped contact');expect(el.textContent).toContain('Customer question');expect(api.post).not.toHaveBeenCalled();
 expect(api.get).toHaveBeenCalledWith('/customer-service/conversations',expect.objectContaining({params:expect.objectContaining({status:'open',assignment:'all',source:'native'})}));
});
test('the fictional non-sandbox preview never claims that customer messages are sent',async()=>{
 api.get.mockImplementation(async url=>response(url.endsWith('/capture-health')?{fictional:true}:url.endsWith('/conversations')?{conversations:[row('a','Fixture contact')]}:{conversation:row('a','Fixture contact'),messages:[],issues:[],actions:[]}));
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Fixture contact');
 expect(el.querySelector('.cs-conversation-footer').textContent).toContain('Fictional local review · No messages are sent');
 expect(el.querySelector('.cs-conversation-footer').textContent).not.toContain('Replies are sent');
});
test('older messages survive incoming polls, deduplicate and retain the selected chat on refresh failure',async()=>{
 let incoming=false,fail=false;
 api.get.mockImplementation(async(url,{params}={})=>{
  if(url.endsWith('/conversations'))return response({conversations:[row('a','Contact A')],hasMore:false});
  if(fail)throw Error('Temporary connection failure');
  return response({conversation:row('a','Contact A'),messages:params.cursor?[message('old','Earlier message','09:00')]:[message('new','Recent message','10:00'),...(incoming?[message('live','Incoming without reload','10:01')]:[])],nextCursor:params.cursor?null:'older1',hasMore:!params.cursor,issues:[],actions:[]});
 });
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Contact A');await click('Load older messages');
 incoming=true;await act(async()=>jest.advanceTimersByTime(5000));
 expect(el.textContent).toContain('Earlier message');expect(el.textContent).toContain('Incoming without reload');
 expect(el.querySelectorAll('#cs-message-new')).toHaveLength(1);expect(el.querySelectorAll('#cs-message-old')).toHaveLength(1);
 fail=true;await act(async()=>jest.advanceTimersByTime(5000));expect(el.textContent).toContain('Temporary connection failure');expect(el.textContent).toContain('Earlier message');
 fail=false;await act(async()=>jest.advanceTimersByTime(5000));expect(el.textContent).not.toContain('Temporary connection failure');expect(el.textContent).toContain('Incoming without reload');
});
test('a late conversation response never appears beneath another contact',async()=>{
 let resolveA;
 api.get.mockImplementation(async url=>{
  if(url.endsWith('/conversations'))return response({conversations:[row('a','Contact A'),row('b','Contact B')]});
  if(url.endsWith('/a'))return new Promise(resolve=>{resolveA=resolve;});
  return response({conversation:row('b','Contact B'),messages:[message('bmsg','Only B history','10:00')],issues:[],actions:[]});
 });
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Contact A');await click('Contact B');
 await act(async()=>resolveA(response({conversation:row('a','Contact A'),messages:[message('amsg','Private A history','10:00')]})));
 expect(el.textContent).toContain('Only B history');expect(el.textContent).not.toContain('Private A history');
});
test('unassigned staff can read an issue but cannot create follow-ups without its permission',async()=>{
 let allowed=false;
 api.get.mockImplementation(async url=>response(url.endsWith('/conversations')?{conversations:[row('a','Contact A')]}:url.endsWith('/owners')?{owners:[]}:{conversation:row('a','Contact A'),messages:[],issues:[{_id:'issue',summary:'Delivery question',canCreateAction:allowed}],actions:[]}));
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Contact A');
 expect(el.textContent).toContain('Delivery question');expect(el.textContent).not.toContain('Add follow-up');
 allowed=true;await act(async()=>jest.advanceTimersByTime(5000));expect(el.textContent).not.toContain('Add follow-up');
});

test('unchanged polls avoid transcript work while recovered context still updates',async()=>{
 let enriched=false;
 api.get.mockImplementation(async url=>response(url.endsWith('/conversations')?{conversations:[row('a','Contact A')]}:url.endsWith('/owners')?{owners:[]}:{conversation:row('a','Contact A'),messages:[{...message('m','Original text','10:00'),...(enriched?{display:{replyContext:{text:'Recovered quoted context'}}}:{})}],issues:[],actions:[]}));
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Contact A');
 const dateRead=jest.spyOn(Date.prototype,'getTime');
 await act(async()=>jest.advanceTimersByTime(5000));
 const unchangedDateReads=dateRead.mock.calls.length;dateRead.mockRestore();
 expect(unchangedDateReads).toBe(0);
 enriched=true;await act(async()=>jest.advanceTimersByTime(5000));
 expect(el.textContent).toContain('Recovered quoted context');
 expect(el.querySelectorAll('#cs-message-m')).toHaveLength(1);
});

test('an older-page click during a background refresh is fulfilled after that refresh',async()=>{
 let hold=false,finishPoll;const latest={conversation:row('a','Contact A'),messages:[message('new','Recent message','10:00')],nextCursor:'older1',hasMore:true,issues:[],actions:[]};
 api.get.mockImplementation(async(url,{params}={})=>{
  if(url.endsWith('/conversations'))return response({conversations:[row('a','Contact A')]});
  if(params.cursor)return response({...latest,messages:[message('old','Queued older message','09:00')],nextCursor:null,hasMore:false});
  if(hold)return new Promise(resolve=>{finishPoll=resolve;});
  return response(latest);
 });
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Contact A');hold=true;
 await act(async()=>jest.advanceTimersByTime(5000));await click('Load older messages');
 await act(async()=>finishPoll(response(latest)));
 expect(el.textContent).toContain('Queued older message');expect(el.textContent).not.toContain('Load older messages');
});

test('open backlog spans all dates and assignment is independent of status',async()=>{
 api.get.mockImplementation(async()=>response({conversations:[]}));
 await act(async()=>root.render(<CustomerChats {...props}/>));
 let params=api.get.mock.calls.at(-1)[1].params;
 expect(params.status).toBe('open');expect(params.from).toBeUndefined();expect(el.textContent).toContain('Backlog · all dates');
 const change=async(label,value)=>{const select=el.querySelector(`[aria-label="${label}"]`);await act(async()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});};
 await change('Assignment','unassigned');params=api.get.mock.calls.at(-1)[1].params;
 expect(params.status).toBe('open');expect(params.assignment).toBe('unassigned');
 await change('Conversation status','resolved');params=api.get.mock.calls.at(-1)[1].params;
 expect(params.status).toBe('resolved');expect(params.assignment).toBe('unassigned');expect(params.from).toBeUndefined();
 await change('Assignment','all');params=api.get.mock.calls.at(-1)[1].params;expect(params.from).toBe('2026-11-06');
 expect(api.post).not.toHaveBeenCalled();expect(api.patch).not.toHaveBeenCalled();
});

test('saving work keeps the open transcript mounted while refreshed data is pending',async()=>{
 let pending=false,finish;
 api.get.mockImplementation(async url=>{
  if(url.endsWith('/conversations'))return response({conversations:[row('a','Contact A')]});
  if(url.endsWith('/owners'))return response({owners:[]});
  if(pending)return new Promise(resolve=>{finish=resolve;});
  return response({conversation:row('a','Contact A'),messages:[message('m','Keep this history visible','10:00')],issues:[],actions:[]});
 });
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Contact A');
 const transcript=el.querySelector('.cs-inbox-transcript');pending=true;
 await act(async()=>root.render(<CustomerChats {...props} epoch={1}/>));
 expect(el.querySelector('.cs-inbox-transcript')).toBe(transcript);
 expect(el.textContent).toContain('Keep this history visible');
 await act(async()=>finish(response({conversation:row('a','Contact A'),messages:[message('m','Keep this history visible','10:00')],issues:[],actions:[]})));
});

test('a chat that leaves the open queue is removed by the next poll',async()=>{
 let resolved=false;api.get.mockImplementation(async url=>response(url.endsWith('/conversations')?{conversations:resolved?[]:[row('a','Contact A')]}:{owners:[]}));
 await act(async()=>root.render(<CustomerChats {...props}/>));expect(el.textContent).toContain('Contact A');resolved=true;
 await act(async()=>jest.advanceTimersByTime(5000));expect(el.textContent).not.toContain('Contact A');expect(el.textContent).toContain('No conversations match');
});
test('older history date controls appear outside backlog and preserve the current search',async()=>{
 api.get.mockResolvedValue(response({conversations:[],hasMore:false}));const onFiltersChange=jest.fn();await act(async()=>root.render(<CustomerChats {...props} filters={{...props.filters,search:'Lucas'}} onFiltersChange={onFiltersChange}/>));
 expect(el.querySelector('[aria-label="Conversation dates"]')).not.toBeNull();expect(el.textContent).toContain('Backlog · all dates');
 await act(async()=>{const select=el.querySelector('[aria-label="Conversation status"]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(el.querySelector('[aria-label="Conversation dates"]')).not.toBeNull();await click('All time');expect(onFiltersChange).toHaveBeenCalledWith({...props.filters,search:'Lucas',from:'',to:''});
});

test('View message loads older pages and focuses the exact evidence; a failed page can be retried without losing the transcript',async()=>{
 let fail=true;api.get.mockImplementation(async(url,{params}={})=>{
  if(url.endsWith('/conversations'))return response({conversations:[row('a','Evidence contact')]});
  if(url.endsWith('/owners'))return response({owners:[]});
  if(params.cursor){if(fail)throw Error('Temporary page failure');return response({conversation:row('a','Evidence contact'),messages:[{...message('exact-evidence','The actual completion reply','09:00'),authorType:'staff'}],hasMore:false,issues:[],actions:[]});}
  return response({conversation:row('a','Evidence contact'),messages:[message('latest','Keep this latest message','10:00')],hasMore:true,nextCursor:'older-evidence',issues:[],actions:[]});
 });
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Evidence contact');await act(async()=>mockWorkProps.onViewMessage('exact-evidence'));expect(el.textContent).toContain('Keep this latest message');expect(el.textContent).toContain('The linked message could not be loaded');
 fail=false;await click('Retry linked message');expect(el.textContent).toContain('The actual completion reply');expect(el.textContent).toContain('Keep this latest message');expect(document.activeElement.id).toBe('cs-message-exact-evidence');expect(el.querySelector('#cs-message-exact-evidence').classList.contains('cs-evidence-target')).toBe(true);expect(api.post).not.toHaveBeenCalled();
});
test('the selected resolved issue can reopen from the exact later customer message and the mobile summary exposes saved essentials',async()=>{
 api.get.mockImplementation(async url=>response(url.endsWith('/conversations')?{conversations:[row('a','Reopen contact')]}:url.endsWith('/owners')?{owners:[{userId:'staff',displayName:'Issue owner'}]}:{conversation:row('a','Reopen contact'),messages:[message('early','Original question','09:00'),message('followup','The problem remains','11:00')],issues:[],actions:[]}));
 await act(async()=>root.render(<CustomerChats {...props}/>));await click('Reopen contact');
 const issue={_id:'selected-issue',version:2,canWork:true,status:'resolved',title:'Delivery problem',ownerId:'staff',resolution:{outcomeLabel:'Day credit applied',at:'2026-11-06T10:30:00Z'}};
 await act(async()=>{mockWorkProps.onActiveIssueChange(issue);mockWorkProps.onOverviewChange({requests:[{...issue,status:'waiting',waitingOn:'Delivery',nextAction:{action:'Verify the credit',dueAt:'2026-11-07T06:00Z'}},{...issue,_id:'sibling',title:'Another issue',status:'open'}],counts:{open:2,resolved:0},selectedId:issue._id});});
 expect(el.querySelector('[aria-label="Current issue summary"]').textContent).toContain('Issue owner');expect(el.querySelector('[aria-label="Current issue summary"]').textContent).toContain('Verify the credit');expect(el.querySelector('[aria-label="Current issue summary"]').textContent).toContain('7 Nov 2026, 10:00');expect(el.querySelectorAll('.cs-message-reopen')).toHaveLength(1);
 expect(el.querySelector('[aria-label="Current issue summary"]').textContent).toContain('2 issues');expect(el.querySelectorAll('[aria-label="Current issue summary"] button')).toHaveLength(1);
 await click('Reopen this issue');expect(mockWorkProps.reopenRequestId).toBe('selected-issue');expect(mockWorkProps.reopenMessage._id).toBe('followup');expect(mockWorkProps.requestId).toBe('selected-issue');expect(api.post).not.toHaveBeenCalled();
 await act(async()=>mockWorkProps.onOverviewChange({requests:[issue],counts:{open:1,resolved:0},selectedId:'',adding:true}));expect(el.querySelector('[aria-label="Current issue summary"]')).toBeNull();
 await act(async()=>mockWorkProps.onOverviewChange({requests:[issue],counts:{open:1,resolved:0},selectedId:issue._id,adding:false}));expect(el.querySelector('[aria-label="Current issue summary"]')).not.toBeNull();
});
