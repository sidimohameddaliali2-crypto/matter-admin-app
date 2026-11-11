import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import RequestActionForm from './RequestActionForm';
import {TOPIC_ACTIONS,ACTION_VERSION} from '../../../../server/config/customerServiceActions';
import {REQUEST_TOPICS} from '../../../../server/config/customerServiceRequests';
jest.mock('../../utils/api',()=>({__esModule:true,default:{post:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,el;
beforeEach(()=>{sessionStorage.clear();el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
const definitions={actions:TOPIC_ACTIONS,actionVersion:ACTION_VERSION,topics:REQUEST_TOPICS};
const messages=[{_id:'customer',authorType:'customer',text:'Customer request',sentAt:'2026-11-09T06:00Z'},{_id:'human',authorType:'staff',text:'Actual human reply',sentAt:'2026-11-09T06:01Z'},{_id:'bot',authorType:'bot',text:'Automatic',sentAt:'2026-11-09T06:01Z'},{_id:'internal',authorType:'staff',internalNote:true,text:'Private note',sentAt:'2026-11-09T06:01Z'}];
async function chooseAction(action,outcome){
 await act(async()=>[...el.querySelectorAll('button')].find(b=>b.textContent===(action.terminal?'Resolve':action.code==='followup_other'?'Follow up':'Update')).click());
 const select=el.querySelector(action.terminal?'[aria-label="What happened?"]':'[aria-label="Update action"]');
 if(select)await act(async()=>{select.value=action.terminal?action.code+':'+outcome.code:action.code;select.dispatchEvent(new Event('change',{bubbles:true}));});
}
for(const topic of REQUEST_TOPICS)test(topic.id+': every action and outcome renders its exact conditional fields',async()=>{
 for(const kind of ['complaint','inquiry'])for(const action of TOPIC_ACTIONS[topic.id])for(const outcome of action.outcomes||[null]){
  const request={_id:[topic.id,kind,action.code,outcome?.code].join(':'),version:1,classification:{topic:topic.id,kind},ownerId:'staff'};
  await act(async()=>root.render(<RequestActionForm key={request._id} request={request} definitions={definitions} messages={messages} owners={[]} actorId="staff" conversationId="chat" capabilities={{closeSensitive:true}} onSaved={jest.fn()}/>));
  await chooseAction(action,outcome);
  for(const field of [...(action.fields||[]),...(outcome?.fields||[])]){const input=el.querySelector(`[aria-label="${field.label}"]`);expect(input).not.toBeNull();expect(input.type).toBe(field.type);expect(input.required).toBe(field.required);}
  expect(Boolean(el.querySelector('[aria-label="Check again · Dubai"]'))).toBe(!action.terminal);
  if(outcome){const choices=[...el.querySelector('[aria-label="Outcome evidence message"]').options].map(o=>o.value);expect(choices).not.toContain('bot');expect(choices).not.toContain('internal');if(outcome.group==='information'&&outcome.code!=='suggestion_passed')expect(choices).toEqual(['','human']);if(outcome.group==='withdrawn')expect(choices).toEqual(['','customer']);}
 }
});
test('ordinary handlers see why sensitive final outcomes are disabled',async()=>{
 for(const topic of ['refund','food_quality']){
  await act(async()=>root.render(<RequestActionForm key={topic} request={{_id:topic,classification:{topic},ownerId:'staff'}} definitions={definitions} owners={[]} actorId="staff" conversationId="chat" capabilities={{}} onSaved={jest.fn()}/>));
  const resolve=[...el.querySelectorAll('button')].find(b=>b.textContent==='Resolve');
  expect(resolve.disabled).toBe(true);
  expect(resolve.title).toContain('authorized closer');
 }
});
test('read-only preview exposes sensitive outcome fields without granting save authority',async()=>{
 await act(async()=>root.render(<RequestActionForm request={{_id:'preview-refund',classification:{topic:'refund'},ownerId:'staff'}} definitions={definitions} owners={[]} actorId="staff" conversationId="chat" capabilities={{previewReadOnly:true}} onSaved={jest.fn()}/>));
 const refund=TOPIC_ACTIONS.refund.find(action=>action.label==='Record processed refund');
 await chooseAction(refund,refund.outcomes[0]);expect(el.querySelector('[aria-label="Amount"]')).not.toBeNull();expect([...el.querySelectorAll('button')].find(b=>b.textContent==='Save outcome').disabled).toBe(true);
});
