import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import RequestActionForm from './RequestActionForm';
import api from '../../utils/api';
import {REQUEST_TOPIC_TAGS} from '../../../../server/config/customerServiceTopicTags';
import {REQUEST_TOPICS as LEGACY_TOPICS} from '../../../../server/config/customerServiceRequests';
import {TOPIC_ACTIONS,ACTION_VERSION} from '../../../../server/config/customerServiceActions';
jest.mock('../../utils/api',()=>({__esModule:true,default:{post:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
const definitions={actionVersion:'v1',topics:[{id:'nutrition',label:'Nutrition / Macros Info'}],actions:{nutrition:[{code:'answer',label:'Record answer',terminal:true,outcomes:[{code:'information_provided',label:'Information provided',group:'information',fields:[{id:'noRemainingAction',label:'No further work needed',type:'checkbox',required:true}]}]},{code:'check',label:'Set a follow-up',terminal:false,fields:[]}]}};
const record={_id:'issue',version:1,classification:{kind:'inquiry',topic:'nutrition'},ownerId:'staff'};
let root,el;
const props={request:record,definitions,owners:[],actorId:'staff',conversationId:'chat',messages:[{_id:'reply',authorType:'staff',text:'Human reply',sentAt:'2026-11-09T06:00Z'}],onSaved:jest.fn()};
beforeEach(()=>{jest.clearAllMocks();sessionStorage.clear();el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
let renderedProps=props;
const render=async(p=props)=>{renderedProps=p;await act(async()=>root.render(<RequestActionForm {...p}/>));};
const directClick=async text=>act(async()=>{const button=[...el.querySelectorAll('button')].find(b=>b.textContent===text);if(!button)throw Error('Button not found: '+text);button.click();});
// Exercise the universal surface while keeping the earlier action-contract cases.
const click=async text=>{
 if([...el.querySelectorAll('button')].some(b=>b.textContent===text)){await directClick(text);return;}
 const action=Object.values(renderedProps.definitions.actions||{}).flat().find(a=>a.label===text);if(!action)throw Error('Action not found: '+text);
 if(action.terminal){await directClick('Resolve');if(action.outcomes?.length===1)await change('What happened?',action.code+':'+action.outcomes[0].code);}
 else{await directClick(action.code==='followup_other'||text==='Set a follow-up'?'Follow up':'Update');const select=el.querySelector('[aria-label="Update action"]');if(select&&select.value!==action.code)await change('Update action',action.code);}
};
const change=async(label,value)=>{
 if(label==='Issue summary'&&!el.querySelector('[aria-label="Issue summary"]'))await directClick([...el.querySelectorAll('button')].some(b=>b.textContent==='Edit description')?'Edit description':'Add description');
 if(label==='Handled by'&&!el.querySelector('[aria-label="Handled by"]'))await directClick('Change');
 await act(async()=>{
  if(label==='Type'){const radio=el.querySelector('[aria-label="Type"] input[value="'+value+'"]');if(!radio)throw Error('Type not found');radio.click();return;}
  const input=el.querySelector('[aria-label="'+label+'"]');if(!input)throw Error('Field not found: '+label);
  if(input.tagName==='SELECT'){
   if(label==='What happened?'&&![...input.options].some(o=>o.value===value)){const option=[...input.options].find(o=>o.value.endsWith(':'+value));if(option)value=option.value;}
   input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));
  }else{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}
 });
};
const save=async()=>act(async()=>el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
const tagDefinitions={topics:REQUEST_TOPIC_TAGS,legacyTopics:LEGACY_TOPICS,actions:TOPIC_ACTIONS,actionVersion:ACTION_VERSION};
test('QA customer promise input saves separately from the internal check time and keeps its draft on failure',async()=>{
 await render({...props,capabilities:{sidebarSandbox:true}});
 await directClick('Follow up');
 await change('What happens next?','Check with the responsible team');
 await change('Check again · Dubai','2026-11-11T10:00');
 await change('Customer update promised · Dubai','2026-11-11T10:30');
 api.post.mockRejectedValueOnce(new Error('Interrupted request'));
 await save();
 expect(api.post.mock.calls[0][1]).toMatchObject({dueAt:'2026-11-11T06:00:00.000Z',customerUpdateDueAt:'2026-11-11T06:30:00.000Z'});
 expect(el.querySelector('[aria-label="Customer update promised · Dubai"]').value).toBe('2026-11-11T10:30');
 expect(el.textContent).toContain('Your draft is kept');
});
test('new issues expose exactly the ten Topic tags and require a matching detail before showing its actions',async()=>{
 await render({...props,request:null,conversationScope:true,definitions:tagDefinitions});
 expect([...el.querySelector('[aria-label="Topic"]').options].filter(option=>option.value).map(option=>option.label)).toEqual(REQUEST_TOPIC_TAGS.map(topic=>topic.label));
 for(const topic of REQUEST_TOPIC_TAGS){
  await change('Topic',topic.id);const detail=el.querySelector('[aria-label="Issue detail"]');expect(detail.required).toBe(true);expect(detail.value).toBe('');expect([...detail.options].filter(option=>option.value).map(option=>option.label)).toEqual(topic.includes.map(reason=>reason.label));expect(el.querySelector('.cs-universal-actions')).toBeNull();
  for(const reason of topic.includes){
   await change('Issue detail',reason.id);const family=TOPIC_ACTIONS[reason.workflowTopic];
   expect([...el.querySelectorAll('.cs-universal-actions button')].map(button=>button.textContent)).toEqual(['Update','Follow up','Resolve']);await click(family.find(action=>!action.terminal&&action.featured!==false).label);expect(el.querySelector('[aria-label="What happens next?"]')).not.toBeNull();
  }
 }
 expect(api.post).not.toHaveBeenCalled();
});
test('changing Topic or detail clears incompatible action fields while preserving the issue summary',async()=>{
 await render({...props,request:null,conversationScope:true,definitions:tagDefinitions});await change('Issue summary','Change the requested plan');await change('Topic','tag_plan');await change('Issue detail','plan_change');await click('Check requested plan change');await change('Requested plan','Three meals');
 await change('Issue detail','cancellation');expect(el.querySelector('[aria-label="Requested plan"]')).toBeNull();expect(el.querySelector('.cs-universal-actions [aria-pressed="true"]')).toBeNull();expect(el.querySelector('.cs-universal-actions')).not.toBeNull();
 await change('Topic','tag_delivery');expect(el.querySelector('[aria-label="Issue detail"]').value).toBe('');expect(el.querySelector('.cs-universal-actions')).toBeNull();expect(el.querySelector('[aria-label="Issue summary"]').value).toBe('Change the requested plan');
 const draft=JSON.parse(sessionStorage.getItem('matter:action-draft:staff:chat:conversation'));expect(draft.fields.subtopic).toBe('');expect(draft.fields.actionCode).toBe('');expect(draft.fields.details).toEqual({});
});
test('website/account handoff records the selected tag and detail with an editable Technical Support waiting default',async()=>{
 await render({...props,request:null,conversationScope:true,definitions:tagDefinitions,owners:[{userId:'staff',displayName:'Fixture staff'}]});await change('Issue summary','Restore the customer account access');await change('Type','complaint');await change('Topic','tag_account');await change('Issue detail','login_issue');await change('Handled by','staff');
 await click('Record Technical Support follow-up');expect(el.querySelector('[aria-label="Waiting for"]').value).toBe('Technical Support');await change('Waiting for','Customer');expect(el.querySelector('[aria-label="Waiting for"]').value).toBe('Customer');await change('Check again · Dubai','2026-11-11T10:00');
 api.post.mockResolvedValueOnce({data:{data:{_id:'new-tag-issue',version:1}}});await save();expect(api.post.mock.calls[0][1].classification).toEqual({kind:'complaint',topic:'tag_account',subtopic:'login_issue'});expect(api.post.mock.calls[0][1].waitingOn).toBe('Customer');expect(api.post.mock.calls[0][1].classification.workflowTopic).toBeUndefined();
});
test('a new-tag draft restores its selected detail and stable retry identifiers after reload',async()=>{
 const own={...props,request:null,conversationScope:true,definitions:tagDefinitions};await render(own);await change('Issue summary','Check the website access issue');await change('Type','inquiry');await change('Topic','tag_account');await change('Issue detail','website_issue');await click('Record Technical Support follow-up');await change('What happens next?','Ask the technical team to review the saved incident');await change('Check again · Dubai','2026-11-11T10:00');
 api.post.mockRejectedValueOnce({response:{status:503,data:{message:'Retry'}}});await save();const first=api.post.mock.calls[0][1];await act(async()=>root.unmount());root=createRoot(el);await render(own);expect(el.querySelector('[aria-label="Topic"]').value).toBe('tag_account');expect(el.querySelector('[aria-label="Issue detail"]').value).toBe('website_issue');expect(el.querySelector('[aria-label="What happens next?"]').value).toBe('Ask the technical team to review the saved incident');
 api.post.mockResolvedValueOnce({data:{data:{_id:'new-tag-issue',version:1}}});await save();expect(api.post.mock.calls[1][1].classification).toEqual(first.classification);expect(api.post.mock.calls[1][1].issueKey).toBe(first.issueKey);expect(api.post.mock.calls[1][1].requestId).toBe(first.requestId);
});
test('saved legacy issues keep their original action family without an invented new tag',async()=>{
 await render({...props,definitions:tagDefinitions});expect(el.querySelector('[aria-label="Topic"]')).toBeNull();expect(el.querySelector('[aria-label="Issue detail"]')).toBeNull();await click('Record nutrition answer');expect(el.textContent).toContain('No further work needed');expect(el.querySelector('[aria-label="Outcome evidence message"]')).not.toBeNull();
 api.post.mockResolvedValueOnce({data:{data:{...record,version:2}}});await save();expect(api.post.mock.calls[0][1].topic).toBe('nutrition');expect(api.post.mock.calls[0][1].classification).toBeUndefined();
});
test('a recovered legacy creation draft remains visible until staff deliberately choose a current tag and detail',async()=>{
 const previous={fields:{kind:'inquiry',topic:'nutrition',title:'Keep the original customer need',ownerId:'staff',actionCode:'specialist',details:{information:'Keep the previous draft detail'},nextAction:'Check the approved source'},commandKey:'retained-key',issueKey:'retained-issue'};
 sessionStorage.setItem('matter:action-draft:staff:chat:conversation',JSON.stringify(previous));await render({...props,request:null,conversationScope:true,definitions:tagDefinitions});
 expect(el.querySelector('[aria-label="Topic"]').value).toBe('nutrition');expect(el.querySelector('[aria-label="Topic"]').selectedOptions[0].textContent).toContain('Saved previous topic: Nutrition / Macros Info');expect([...el.querySelector('[aria-label="Topic"]').options].filter(option=>option.value&&!option.disabled)).toHaveLength(10);expect(el.textContent).toContain('Keep the previous draft detail');expect(el.textContent).toContain('Choose a current topic and issue detail');expect(el.querySelector('.cs-universal-actions')).toBeNull();expect(JSON.parse(sessionStorage.getItem('matter:action-draft:staff:chat:conversation')).fields).toEqual(previous.fields);
 await change('Topic','tag_plan');expect(el.querySelector('[aria-label="Issue detail"]').value).toBe('');await click('Edit description');expect(el.querySelector('[aria-label="Issue summary"]').value).toBe('Keep the original customer need');expect(api.post).not.toHaveBeenCalled();
});
test('a restored draft with an unavailable detail shows its saved input rather than a silent blank selector',async()=>{
 const previous={fields:{kind:'inquiry',topic:'tag_plan',subtopic:'previous_detail',title:'Keep this customer need',actionCode:'check',details:{note:'Keep the previous conditional input'}},commandKey:'retained-key',issueKey:'retained-issue'};sessionStorage.setItem('matter:action-draft:staff:chat:conversation',JSON.stringify(previous));
 await render({...props,request:null,conversationScope:true,definitions:tagDefinitions});expect(el.querySelector('[aria-label="Issue detail"]').selectedOptions[0].textContent).toContain('Saved previous issue detail');expect(el.textContent).toContain('Choose a current issue detail');expect(el.textContent).toContain('Keep the previous conditional input');expect(el.querySelector('.cs-universal-actions')).toBeNull();
 await change('Issue detail','plan_renewal');await click('Edit description');expect(el.querySelector('[aria-label="Issue summary"]').value).toBe('Keep this customer need');expect(el.textContent).not.toContain('saved issue detail is no longer available');expect(api.post).not.toHaveBeenCalled();
});
test('sensitive closure follows the selected detail workflow rather than the broad Topic tag',async()=>{
 await render({...props,request:null,conversationScope:true,definitions:tagDefinitions});await change('Topic','tag_delivery');await change('Issue detail','temperature');
 expect([...el.querySelectorAll('button')].find(button=>button.textContent==='Resolve').disabled).toBe(true);expect([...el.querySelectorAll('button')].find(button=>button.textContent==='Update').disabled).toBe(false);
});
test('a changed detail within the same Topic retains the old draft until a new workflow action is explicitly chosen',async()=>{
 const pause={...record,classification:{kind:'complaint',topic:'tag_plan',subtopic:'subscription_pause'}};await render({...props,request:pause,definitions:tagDefinitions});await click('Check requested pause');await change('Requested dates','Keep the previous pause dates');
 const changed={...pause,version:2,classification:{kind:'inquiry',topic:'tag_plan',subtopic:'plan_change'}};await render({...props,request:changed,definitions:tagDefinitions});expect(el.textContent).toContain('Plan & Subscription · Plan Change');expect(el.textContent).toContain('Keep the previous pause dates');expect(el.querySelector('.cs-universal-actions')).not.toBeNull();expect(el.querySelector('[aria-label="Requested dates"]')).toBeNull();await click('Check requested plan change');
 api.post.mockResolvedValueOnce({data:{data:{...changed,version:3}}});await save();expect(api.post.mock.calls[0][1].version).toBe(2);expect(api.post.mock.calls[0][1].topic).toBe('tag_plan');expect(api.post.mock.calls[0][1].subtopic).toBe('plan_change');expect(api.post.mock.calls[0][1].details).toEqual({});
});
test('Other starts its editable problem description from the conversation issue summary',async()=>{
 const otherDefinitions={...definitions,topics:[{id:'other',label:'Other'}],actions:{other:[{code:'describe',label:'Describe problem',terminal:false,fields:[{id:'problem',label:'Short problem description',type:'text',required:true}]}]}};
 await render({...props,request:null,conversationScope:true,definitions:otherDefinitions});await change('Issue summary','Clarify the customer account request');await change('Topic','other');await click('Describe problem');
 expect(el.querySelector('[aria-label="Short problem description"]').value).toBe('Clarify the customer account request');await change('Short problem description','Confirm the request and the expected next step');expect(el.querySelector('[aria-label="Short problem description"]').value).toBe('Confirm the request and the expected next step');expect(el.querySelector('[aria-label="Issue summary"]').value).toBe('Clarify the customer account request');
});
test('a non-customer issue reopens with an explicit customer classification and retains its handler',async()=>{
 const excluded={...record,status:'non_customer',classification:{kind:'vendor',topic:null}};
 await render({...props,request:excluded,reopen:true,messages:[...props.messages,{_id:'customer-reopen',authorType:'customer',text:'I am asking about my own subscription'}]});
 expect(el.querySelector('[aria-label="Type"] input:checked')).toBeNull();expect(el.querySelector('[aria-label="Topic"]').value).toBe('');expect(el.querySelector('[aria-label="Handled by"]')).toBeNull();
 await change('Why reopen this issue?','Customer request was misclassified');await change('Related customer message','customer-reopen');await change('Type','inquiry');await change('Topic','nutrition');await click('Set a follow-up');await change('What happens next?','Confirm the customer request');await change('Check again · Dubai','2026-11-11T10:00');
 api.post.mockResolvedValueOnce({data:{data:{...excluded,version:2,status:'open',classification:{kind:'inquiry',topic:'nutrition'}}}});await save();expect(api.post.mock.calls[0][1].classification).toEqual({kind:'inquiry',topic:'nutrition'});expect(api.post.mock.calls[0][1].reopen).toBe(true);expect(api.post.mock.calls[0][1].reopenMessageId).toBe('customer-reopen');
});
test('a changed topic keeps the old draft visible until staff explicitly choose an action for the updated topic',async()=>{
 const changedDefinitions={...definitions,topics:[...definitions.topics,{id:'pause',label:'Skip / Pause'}],actions:{...definitions.actions,pause:[{code:'check_pause',label:'Check pause dates',terminal:false,fields:[{id:'period',label:'Requested dates',type:'text',required:true}]}]}};
 const pause={...record,classification:{kind:'complaint',topic:'pause'}};await render({...props,request:pause,definitions:changedDefinitions});await click('Check pause dates');await change('Requested dates','Keep this unsubmitted pause note');
 const nutrition={...pause,version:2,classification:{kind:'inquiry',topic:'nutrition'}};await render({...props,request:nutrition,definitions:changedDefinitions});expect(el.textContent).toContain('issue topic changed to Nutrition / Macros Info');expect(el.textContent).toContain('Keep this unsubmitted pause note');expect(el.querySelector('[aria-label="Requested dates"]')).toBeNull();expect(el.querySelector('.cs-universal-actions')).not.toBeNull();
 await click('Set a follow-up');api.post.mockResolvedValueOnce({data:{data:{...nutrition,version:3}}});await save();expect(api.post.mock.calls[0][1].version).toBe(2);expect(api.post.mock.calls[0][1].topic).toBe('nutrition');expect(api.post.mock.calls[0][1].actionCode).toBe('check');expect(api.post.mock.calls[0][1].details).toEqual({});
});
test('an untouched form adopts a refreshed request version before staff begin an action',async()=>{
 await render();await render({...props,request:{...record,version:2,nextAction:{action:'Current saved next step',dueAt:'2026-11-12T06:00Z'}}});await click('Set a follow-up');api.post.mockResolvedValueOnce({data:{data:{...record,version:3}}});await save();expect(api.post.mock.calls[0][1].version).toBe(2);
});
test('an assignment suggestion arriving after the form opens fills the new issue without overriding a staff choice',async()=>{
 const own={...props,request:null,conversationScope:true,owners:[{userId:'staff',displayName:'Fixture staff'},{userId:'other',displayName:'Other staff'}]};
 await render(own);expect(el.querySelector('[aria-label="Handled by"]').value).toBe('');await render({...own,suggestedOwnerId:'staff'});expect(el.textContent).toContain('Fixture staff');await change('Handled by','other');await render({...own,suggestedOwnerId:'staff'});expect(el.textContent).toContain('Other staff');expect(api.post).not.toHaveBeenCalled();
});
test('conversation issue creation sends the conversation and retains its stable issue key across retry and reload',async()=>{
 await render({...props,request:null,message:undefined,conversationScope:true});await change('Issue summary','Confirm the requested nutrition advice');await change('Type','inquiry');await change('Topic','nutrition');await click('Set a follow-up');
 api.post.mockRejectedValueOnce({response:{status:503,data:{message:'Retry'}}});await save();const first=api.post.mock.calls[0][1];expect(first.conversationId).toBe('chat');expect(first.messageId).toBeUndefined();expect(first.issueKey).toBeTruthy();
 await act(async()=>root.unmount());root=createRoot(el);await render({...props,request:null,message:undefined,conversationScope:true});expect(el.textContent).not.toContain('Your draft is restored');api.post.mockResolvedValueOnce({data:{data:{_id:'new',version:1}}});await save();expect(api.post.mock.calls[1][1].issueKey).toBe(first.issueKey);expect(api.post.mock.calls[1][1].requestId).toBe(first.requestId);expect(sessionStorage.getItem('matter:action-draft:staff:chat:conversation')).toBeNull();
});
test('answer shows human evidence and no future task or repeated owner selection',async()=>{await render();await click('Record answer');expect(el.textContent).toContain('No further work needed');expect(el.querySelector('[aria-label="Outcome evidence message"]')).not.toBeNull();expect(el.querySelector('[type="datetime-local"]')).toBeNull();expect(el.querySelector('[aria-label="Handled by"]')).toBeNull();});
test('local viewing mode allows exploring fields but never posts a save',async()=>{
 await render({...props,capabilities:{previewReadOnly:true}});await click('Set a follow-up');expect(el.querySelector('[aria-label="What happens next?"]')).not.toBeNull();expect([...el.querySelectorAll('button')].find(b=>b.textContent==='Save follow-up').disabled).toBe(true);await save();expect(api.post).not.toHaveBeenCalled();expect(el.textContent).toContain('Live records are not changed');
});
test('an edited action explicitly stays unsaved until the server confirms it',async()=>{
 await render();expect(el.textContent).not.toContain('Unsaved');await click('Set a follow-up');await change('What happens next?','Check the operational record');expect(el.textContent).toContain('Unsaved');
 api.post.mockResolvedValueOnce({data:{data:{...record,version:2}}});await save();expect(el.textContent).not.toContain('Unsaved');
});
test('blocked browser storage cannot misreport a server-confirmed save as a failure',async()=>{
 await render();await click('Set a follow-up');api.post.mockResolvedValueOnce({data:{data:{...record,version:2}}});const blocked=jest.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('Storage blocked');});
 try{await save();expect(props.onSaved).toHaveBeenCalledWith({...record,version:2});expect(el.textContent).not.toContain('Not saved.');}finally{blocked.mockRestore();}
});
test('failed save retains input and exact retry key; successful save clears draft',async()=>{
 await render();await click('Set a follow-up');await change('What happens next?','Ask approved specialist');await change('Check again · Dubai','2026-11-10T10:00');
 api.post.mockRejectedValueOnce({response:{status:503,data:{message:'Temporary failure'}}});await save();const first=api.post.mock.calls[0][1];expect(el.textContent).toContain('Not saved. Your draft is kept.');expect(el.querySelector('[aria-label="What happens next?"]').value).toBe('Ask approved specialist');
 api.post.mockResolvedValueOnce({data:{data:{...record,version:2,updatedAt:'2026-11-09T06:00Z'}}});await save();expect(api.post.mock.calls[1][1]).toEqual(first);expect(first.dueAt).toBe('2026-11-10T06:00:00.000Z');expect(sessionStorage.getItem('matter:action-draft:staff:chat:issue')).toBeNull();
});
test('reload preserves the draft version despite polling; explicit conflict review uses latest version',async()=>{
 await render();await click('Set a follow-up');await change('What happens next?','Keep this input');await act(async()=>root.unmount());root=createRoot(el);await render({...props,request:{...record,version:2}});expect(el.textContent).not.toContain('Your draft is restored');
 api.post.mockRejectedValueOnce({response:{status:409,data:{message:'Issue changed'}}});await save();expect(api.post.mock.calls[0][1].version).toBe(1);expect(el.querySelector('[aria-label="What happens next?"]').value).toBe('Keep this input');await click('Review latest version and keep my input');api.post.mockResolvedValueOnce({data:{data:{...record,version:3}}});await save();expect(api.post.mock.calls[1][1].version).toBe(2);
});
test('account and issue drafts remain separate, and untouched forms do not create drafts',async()=>{
 await render();expect(sessionStorage.length).toBe(0);await click('Set a follow-up');await change('What happens next?','Only issue A');await act(async()=>root.unmount());root=createRoot(el);await render({...props,request:{...record,_id:'other'}});expect(el.textContent).not.toContain('Your draft is restored');expect(el.querySelector('[aria-label="What happens next?"]')).toBeNull();expect(sessionStorage.getItem('matter:action-draft:staff:chat:issue')).toContain('Only issue A');
});
test('pending submission disables form fields and duplicate submits issue only one command',async()=>{await render();await click('Set a follow-up');let finish;api.post.mockImplementation(()=>new Promise(r=>{finish=r;}));await save();await save();expect(api.post).toHaveBeenCalledTimes(1);expect(el.querySelector('.cs-action-fields').disabled).toBe(true);await act(async()=>finish({data:{data:{...record,version:2}}}));});
test('a new issue uses its selected detail as the title without requiring a written summary',async()=>{
 await render({...props,request:null,conversationScope:true,definitions:tagDefinitions,owners:[{userId:'staff',displayName:'Fixture staff'}]});
 await change('Type','complaint');await change('Topic','tag_account');await change('Issue detail','login_issue');await change('Handled by','staff');
 expect(el.querySelector('[aria-label="Issue summary"]')).toBeNull();expect(el.textContent).not.toContain('What does the customer need?');
 await directClick('Follow up');await change('What happens next?','Check the reported access failure');await change('Check again · Dubai','2026-11-11T10:00');
 api.post.mockResolvedValueOnce({data:{data:{_id:'new',version:1}}});await save();
 const body=api.post.mock.calls[0][1];expect(body.title).toBe('Login Issue');expect(body.classification).toEqual({kind:'complaint',topic:'tag_account',subtopic:'login_issue'});expect(body.uiMode).toBeUndefined();
});
test('restoring a draft keeps its description without adding a visible restoration banner',async()=>{
 const previous={fields:{kind:'complaint',topic:'tag_account',subtopic:'login_issue',title:'Keep the customer wording',ownerId:'staff'},commandKey:'retained-key',issueKey:'retained-issue'};
 sessionStorage.setItem('matter:action-draft:staff:chat:conversation',JSON.stringify(previous));await render({...props,request:null,conversationScope:true,definitions:tagDefinitions,owners:[{userId:'staff',displayName:'Fixture staff'}]});
 expect(el.textContent).not.toContain('Your draft is restored');expect(el.querySelector('.cs-notice')).toBeNull();expect(el.querySelector('[aria-label="Issue summary"]')).toBeNull();
 await directClick('Edit description');expect(el.querySelector('[aria-label="Issue summary"]').value).toBe('Keep the customer wording');expect(JSON.parse(sessionStorage.getItem('matter:action-draft:staff:chat:conversation')).fields.title).toBe(previous.fields.title);
});
test('Resolve requires an explicit outcome and clearing it restores the empty outcome state',async()=>{
 await render();await directClick('Resolve');expect(el.querySelector('[aria-label="What happened?"]').value).toBe('');expect(el.querySelector('[aria-label="Outcome evidence message"]')).toBeNull();expect(api.post).not.toHaveBeenCalled();
 await change('What happened?','answer:information_provided');expect(el.querySelector('[aria-label="Outcome evidence message"]')).not.toBeNull();
 await change('What happened?','');expect(el.querySelector('[aria-label="What happened?"]').value).toBe('');expect(el.querySelector('[aria-label="Outcome evidence message"]')).toBeNull();expect([...el.querySelectorAll('button')].some(b=>b.textContent==='Save answer')).toBe(false);
});
test('a topic changed by another editor can use Resolve only after explicitly adopting the new classification',async()=>{
 const old={...record,classification:{kind:'complaint',topic:'tag_plan',subtopic:'subscription_pause'}};await render({...props,request:old,definitions:tagDefinitions});await directClick('Update');await change('Requested dates','Retain the original pause input');
 const changed={...old,version:2,classification:{kind:'inquiry',topic:'tag_account',subtopic:'login_issue'}};await render({...props,request:changed,definitions:tagDefinitions});expect(el.textContent).toContain('Retain the original pause input');
 await directClick('Resolve');await change('What happened?','answer:information_provided');api.post.mockResolvedValueOnce({data:{data:{...changed,version:3}}});await save();
 expect(api.post.mock.calls[0][1].version).toBe(2);expect(api.post.mock.calls[0][1].topic).toBe('tag_account');expect(api.post.mock.calls[0][1].subtopic).toBe('login_issue');expect(api.post.mock.calls[0][1].details).toEqual({});
});
test('every workflow outcome maps back to its original action code, required fields and evidence',async()=>{
 for(const [topic,actions]of Object.entries(TOPIC_ACTIONS)){
  await act(async()=>root.unmount());root=createRoot(el);
  const classification=topic==='account_support'?{kind:'inquiry',topic:'tag_account',subtopic:'login_issue'}:topic==='menu_support'?{kind:'inquiry',topic:'tag_menu',subtopic:'photos'}:{kind:'inquiry',topic};
  const current={...record,_id:'case-'+topic,classification};
  await render({...props,request:current,definitions:tagDefinitions,capabilities:{closeSensitive:true},messages:[...props.messages,{_id:'customer',authorType:'customer',text:'I withdraw this request'}]});
  const choices=actions.filter(action=>action.terminal).flatMap(action=>action.outcomes.map(outcome=>({action,outcome})));
  await directClick('Resolve');expect([...el.querySelector('[aria-label="What happened?"]').options].filter(option=>option.value).map(option=>option.value)).toEqual(choices.map(({action,outcome})=>action.code+':'+outcome.code));
  for(const {action,outcome}of choices){
   if(!el.querySelector('[aria-label="What happened?"]'))await directClick('Resolve');await change('What happened?',action.code+':'+outcome.code);
   const fields=[...(action.fields||[]),...(outcome.fields||[])].filter((field,index,all)=>all.findIndex(candidate=>candidate.id===field.id)===index);
   for(const field of fields){
    const input=[...el.querySelectorAll('input')].find(node=>node.getAttribute('aria-label')===field.label);expect(input).toBeDefined();expect(input.required).toBe(field.required);
    if(field.type==='checkbox'){if(!input.checked)await act(async()=>input.click());}else await change(field.label,field.type==='number'?'120':field.type==='date'?'2026-11-11':'Synthetic verified reference');
   }
   await change('Outcome evidence message',outcome.group==='withdrawn'?'customer':'reply');
   api.post.mockImplementationOnce(async(url,body)=>({data:{data:{...current,version:body.version+1}}}));await save();
   const body=api.post.mock.calls.at(-1)[1];expect(body.actionCode).toBe(action.code);expect(body.outcomeCode).toBe(outcome.code);expect(body.uiMode).toBeUndefined();
   for(const field of fields.filter(field=>field.required))expect(body.details[field.id]).toBeDefined();
  }
 }
});
