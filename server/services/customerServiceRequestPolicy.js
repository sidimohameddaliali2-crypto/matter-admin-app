import {REQUEST_TOPICS,REQUEST_RULES} from '../config/customerServiceRequests.js';
import {serviceError} from './customerServicePolicy.js';
const fail=m=>{throw serviceError(m,400);};
export const requiredText=(v,label,max=2000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(`${label} is required.`);return v.trim();};
export const validDate=(v,label)=>{const d=new Date(v);if(!v||!Number.isFinite(+d))fail(`${label} must be a valid time.`);return d;};
export function classifyRequest(input){
 if(input?.kind==='spam'||input?.kind==='vendor')return {kind:input.kind,topic:null,group:'Non-customer',version:'2026-11-09'};
 const topic=REQUEST_TOPICS.find(t=>t.id===input?.topic);
 if(!['complaint','inquiry'].includes(input?.kind)||!topic)fail('Choose Complaint or Inquiry and one topic.');
 return {kind:input.kind,topic:topic.id,group:topic.group,version:'2026-11-09'};
}
export function businessSeconds(start,end,calendar){
 if(!calendar?.confirmed||!Array.isArray(calendar.workingDays)||!Array.isArray(calendar.holidays))return null;
 const from=+new Date(start),to=+new Date(end);if(!Number.isFinite(from)||!Number.isFinite(to)||to<from)return null;
 let total=0;const shift=4*3600000,day=86400000;
 for(let t=Math.floor((from+shift)/day)*day;t<=to+shift;t+=day){const d=new Date(t),key=d.toISOString().slice(0,10);if(!calendar.workingDays.includes(d.getUTCDay())||calendar.holidays.includes(key))continue;total+=Math.max(0,Math.min(to,t+17*3600000-shift)-Math.max(from,t+8*3600000-shift));}
 return total/1000;
}
export function validateRule(input){
 if(!REQUEST_RULES.includes(input?.id))fail('Unknown rule.');
 if(input.active!==true)return {...input,active:false};
 requiredText(input.definition,'Policy definition');requiredText(input.approvalAuthority,'Approval authority');
 validDate(input.effectiveAt,'Effective date');
 if(!Array.isArray(input.scope)||!input.scope.length||input.scope.some(t=>!REQUEST_TOPICS.some(x=>x.id===t)&&t!=='all'))fail('Choose the applicable topics.');
 if(!Array.isArray(input.permittedExceptions))fail('Define permitted exceptions, including an empty list when none apply.');
 if(['assignment_overdue','response_overdue'].includes(input.id)){
  if(!Number.isFinite(input.thresholdMinutes)||input.thresholdMinutes<=0)fail('Confirm a positive threshold.');
  const c=input.calendar;if(c?.confirmed!==true||c.timezone!=='Asia/Dubai'||!Array.isArray(c.workingDays)||!c.workingDays.length||c.workingDays.some(d=>!Number.isInteger(d)||d<0||d>6)||!Array.isArray(c.holidays)||c.holidays.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)))fail('Confirm working days and holiday dates for 08:00–17:00 Asia/Dubai.');
 }
 if(input.escalateAfterMinutes!==undefined&&(!Number.isFinite(input.escalateAfterMinutes)||input.escalateAfterMinutes<=0))fail('Escalation threshold must be positive.');
 return input;
}
export function closureRequirements(request){
 if(['spam','vendor'].includes(request.classification?.kind))return ['nonCustomerReason'];
 if(request.classification?.kind==='inquiry')return ['answerProvided','noRemainingAction'];
 switch(request.classification?.topic){
  case 'delivery_missed':return ['deliveryOrAlternativeCompleted'];
  case 'pause':return ['requestedDatesChanged','customerInformed'];
  case 'refund':return ['refundAuthorized','refundProcessed','reference'];
  case 'meal_selection':return ['remedyCompleted','customerInformed'];
  default:return ['requestedEffectCompleted','customerInformed'];
 }
}
export function validateResolution(request,input){
 if(!request.classification)fail('Classify the request before closing it.');
 if(!request.ownerId)fail('An accountable owner is required.');
 if(!['customer_confirmed','verified_completion','closed_without_response'].includes(input?.basis))fail('Choose how resolution was established.');
 requiredText(input.note,'Resolution evidence');
 for(const key of closureRequirements(request)){if(key==='reference'||key==='nonCustomerReason')requiredText(input[key],key);else if(input[key]!==true)fail(`Complete resolution requirement: ${key}.`);}
 if(request.followups?.some(f=>f.status!=='completed'))fail('Complete outstanding follow-ups before closing.');
 if(request.exceptions?.some(e=>e.status==='pending'))fail('An exception is awaiting approval.');
 return {...input,requirements:closureRequirements(request)};
}
// Stable IDs identify one warning per source obligation and rule revision.
export function requestFlags(request,rules,now=new Date(),response){
 const flags=[],active=rules.filter(r=>r.active&&new Date(r.effectiveAt)<=now&&(r.scope.includes('all')||r.scope.includes(request.classification?.topic)));
 const add=(rule,key,at,evidence)=>{const id=`${request._id}:${rule.id}:${rule.version||1}:${key}`;const age=evidence.businessSeconds!==undefined?Math.max(0,evidence.businessSeconds/60-(rule.thresholdMinutes||0)):(+now-+new Date(at))/60000;flags.push({id,rule:rule.id,level:'operational_warning',evidence,ownerId:request.ownerId||null,nextAction:rule.definition,occurredAt:at,acknowledgement:request.acknowledged?.find(a=>a.id===id)||null,escalated:!!rule.escalateAfterMinutes&&age>=rule.escalateAfterMinutes});};
 for(const rule of active){
  if(request.status==='resolved'||request.status==='non_customer')continue;
  if(rule.id==='assignment_overdue'&&!request.ownerId){const seconds=businessSeconds(request.receivedAt,now,rule.calendar);if(seconds!==null&&seconds>rule.thresholdMinutes*60)add(rule,'assignment',request.receivedAt,{messageId:request.originMessageId,businessSeconds:seconds});}
  if(rule.id==='response_overdue'&&response?.waitingSince){const seconds=businessSeconds(response.waitingSince,now,rule.calendar);if(seconds!==null&&seconds>rule.thresholdMinutes*60)add(rule,String(response.messageId),response.waitingSince,{...response,businessSeconds:seconds});}
  if(rule.id==='followup_overdue')for(const f of request.followups||[])if(f.status!=='completed'&&new Date(f.dueAt)<now)add(rule,`${f.id}:${new Date(f.dueAt).toISOString()}`,f.dueAt,{followupId:f.id,action:f.action,responsibleId:f.responsibleId,dueAt:f.dueAt});
  if(rule.id==='resolution_incomplete'&&request.history?.some(h=>h.event==='closure_rejected'))add(rule,'closure',request.history.filter(h=>h.event==='closure_rejected').at(-1).at,{requirements:closureRequirements(request)});
  if(rule.id==='policy_exception')for(const e of request.exceptions||[])if(e.status==='pending'){add(rule,e.id,e.at,{exceptionId:e.id,policyId:e.policyId,reason:e.reason});flags.at(-1).level='suspected_exception';}
 }
 return flags;
}
