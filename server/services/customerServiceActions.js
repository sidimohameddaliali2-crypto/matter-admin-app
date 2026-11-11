import {ACTION_VERSION,actionDefinition} from '../config/customerServiceActions.js';
import {requestWorkflowTopic} from '../config/customerServiceTopicTags.js';
import {requiredText,validDate} from './customerServiceRequestPolicy.js';
import {isServiceStaffReply} from './customerServiceMessageEvidence.js';
import {serviceError} from './customerServicePolicy.js';
const fail=message=>{throw serviceError(message,400);};
function pendingOperations(request){
 const pending=new Map();let recordedWork=false;
 const remember=snapshot=>{
  const topic=requestWorkflowTopic(snapshot?.classification),action=actionDefinition(topic,snapshot?.currentActionCode);
  if(action&&!action.terminal&&action.code!=='followup_other')pending.set(topic,action);
 };
 for(const entry of request.history||[]){
  // A recorded terminal outcome ends the old work interval. Reopening keeps
  // that outcome in history while starting a new interval of pending work.
  if(['resolved','non_customer'].includes(entry.after?.status)){pending.clear();continue;}
  if(entry.event==='work'&&entry.after?.currentActionCode){recordedWork=true;remember(entry.after);}
 }
 if(!recordedWork&&!['resolved','non_customer'].includes(request.status))remember(request);
 return [...pending.keys()];
}
export function validateWorkAction(request,input,evidence){
 if(input.definitionVersion!==ACTION_VERSION)fail('The work form changed. Reload the definitions; your draft is retained.');
 const workflowTopic=requestWorkflowTopic(request.classification),action=actionDefinition(workflowTopic,input.actionCode);
 if(!action)fail('Choose an action for this topic.');
 const outcome=action.terminal?action.outcomes.find(o=>o.code===input.outcomeCode):null;
 if(action.terminal&&!outcome)fail('Choose what happened.');
 const details={};
 for(const f of [...(action.fields||[]),...(outcome?.fields||[])]){
  const v=input.details?.[f.id];
  if(!f.required&&(v==null||v===''))continue;
  if(f.type==='checkbox'){if(v!==true)fail('Confirm: '+f.label);details[f.id]=true;}
  else if(f.type==='number'){if(!['string','number'].includes(typeof v)||typeof v==='string'&&!v.trim()||!Number.isFinite(Number(v))||Number(v)<0)fail(f.label+' must be a non-negative number.');details[f.id]=Number(v);}
  else if(f.type==='date'){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail(f.label+' must be a valid date.');details[f.id]=v;}
  else details[f.id]=requiredText(v,f.label);
 }
 if(details.periodStart&&details.periodEnd&&details.periodEnd<details.periodStart)fail('The renewed period must end after it starts.');
 if(!action.terminal){
  const waitingOn=input.waitingOn||'';if(!['','Customer','Delivery','Kitchen','Finance','Technical Support'].includes(waitingOn))fail('Choose the customer or an available team.');
  const promise=Object.hasOwn(input,'customerUpdateDueAt')?{customerUpdateDueAt:input.customerUpdateDueAt?validDate(input.customerUpdateDueAt,'Customer update promised'):null}:{};
  return {action,outcome:null,details,waitingOn,...promise,nextAction:{action:requiredText(input.nextAction,'What happens next?'),dueAt:validDate(input.dueAt,'Check again')}};
 }
 const selected=evidence.find(m=>String(m._id)===input.evidenceMessageId);
 const reference=typeof input.evidenceReference==='string'?input.evidenceReference.trim():'';
 if(outcome.group==='information'){
  const pending=pendingOperations(request);
  const completesTopicResponse=action.code!=='answer'&&outcome.code!=='suggestion_passed'&&pending.every(topic=>topic===workflowTopic);
  if(pending.length&&!completesTopicResponse)fail('An operational action remains. Record its outcome rather than an answer alone.');
 }
 if(outcome.group==='information'&&outcome.code!=='suggestion_passed'){
  if(!selected||!isServiceStaffReply(selected)||selected.display?.automatedReply===true)fail('Select the actual human reply already sent to the customer.');
 }else if(!selected&&!reference)fail('Select evidence or record an attributable completion reference.');
 if(outcome.group==='withdrawn'&&(!selected||selected.authorType!=='customer'))fail('Select the customer message confirming withdrawal or decline.');
 if(request.followups?.some(f=>f.status!=='completed'))fail('Complete the outstanding follow-ups before finishing this issue.');
 if(request.exceptions?.some(e=>e.status==='pending'))fail('An exception is awaiting approval.');
 return {action,outcome,details,evidenceMessageId:selected?String(selected._id):null,evidenceReference:reference||null};
}
export function applyWorkAction(request,input,validated,actorId,now){
 const {action,outcome,details}=validated;
 request.workflowDefinitionVersion=ACTION_VERSION;request.currentActionCode=action.code;
 request.topicDetails={...(request.topicDetails||{}),...details};
 if(!action.terminal){
  if(Object.hasOwn(validated,'customerUpdateDueAt'))request.customerUpdateDueAt=validated.customerUpdateDueAt;
  const pending=[...(request.followups||[])].filter(f=>f.status!=='completed').sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt))[0];
  if(pending){pending.action=validated.nextAction.action;pending.dueAt=validated.nextAction.dueAt;request.markModified?.('followups');}
  request.nextAction=validated.nextAction;request.waitingOn=validated.waitingOn;request.status=validated.waitingOn?'waiting':'open';return;}
 request.resolution={outcomeCode:outcome.code,outcomeLabel:outcome.label,outcomeGroup:outcome.group,definitionVersion:ACTION_VERSION,details,basis:validated.evidenceMessageId?'linked_evidence':'staff_recorded_reference',evidenceMessageId:validated.evidenceMessageId,evidenceReference:validated.evidenceReference,note:outcome.label+(validated.evidenceReference?' · '+validated.evidenceReference:''),at:now,actorId};
 request.status='resolved';request.waitingOn='';
 if(validated.evidenceMessageId&&!request.evidenceMessageIds.some(id=>String(id)===validated.evidenceMessageId))request.evidenceMessageIds.push(validated.evidenceMessageId);
}
