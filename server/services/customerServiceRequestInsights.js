import {createHash} from 'node:crypto';
import {REQUEST_TOPICS} from '../config/customerServiceRequests.js';
import {businessSeconds} from './customerServiceRequestPolicy.js';
import {isServiceStaffReply} from './customerServiceMessageEvidence.js';
export const REQUEST_METRICS_VERSION='request-metrics-2026-11-09.1';
export const SUGGESTION_VERSION='request-rules-2026-11-09.1';
const ref=value=>String(value?._id||value||'');
const time=value=>value?Date.parse(value):NaN;
const hourLabel=value=>String(Math.floor(value)).padStart(2,'0')+':'+String(Math.round(value%1*60)).padStart(2,'0');
export const DEFAULT_METRICS_CALENDAR={confirmed:false,weeklyHoursConfirmed:true,holidayCalendarConfirmed:false,timezone:'Asia/Dubai',workingDays:[0,1,2,3,4,5,6],holidays:[],hoursByDay:{0:{start:9,end:18},1:{start:8,end:17},2:{start:8,end:17},3:{start:8,end:17},4:{start:8,end:17},5:{start:9,end:18},6:{start:9,end:18}},effectiveFrom:'2026-08-08T00:00:00+04:00',effectiveFromBasis:'Workbook period corroboration; not user retroactive-policy approval',authority:'User-confirmed weekly hours. Workbook period is reference context; holidays and historical effective date await confirmation.'};
const windowCalendar={...DEFAULT_METRICS_CALENDAR,confirmed:true,holidayCalendarConfirmed:true};
export function validateMetricsCalendar(input={}){
 const invalid=message=>{throw Object.assign(new Error(message),{statusCode:400});};
 if(input.timezone!=='Asia/Dubai')invalid('Use Asia/Dubai and explicit daily working windows.');
 if(!Array.isArray(input.workingDays)||input.workingDays.some(d=>!Number.isInteger(d)||d<0||d>6)||new Set(input.workingDays).size!==input.workingDays.length)invalid('Choose unique working days.');
 if(!Array.isArray(input.holidays)||input.holidays.some(d=>typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))invalid('Use valid holiday dates.');
 if(input.confirmed===true&&input.holidayCalendarConfirmed!==true)invalid('Confirm the holiday list before publishing confirmed working-time metrics.');
 if(input.confirmed===true&&(!input.workingDays.length||typeof input.authority!=='string'||!input.authority.trim()||!Number.isFinite(time(input.effectiveFrom))))invalid('Confirmed calendars require working days, authority and an effective date.');
 const hoursByDay=input.hoursByDay||DEFAULT_METRICS_CALENDAR.hoursByDay;
 if(Object.entries(hoursByDay).some(([day,h])=>!/^([0-6])$/.test(day)||!Number.isFinite(h?.start)||!Number.isFinite(h?.end)||h.start<0||h.end>24||h.end<=h.start)||input.workingDays.some(day=>!hoursByDay[day]))invalid('Define a valid start and end hour for each working day.');
 return {timezone:'Asia/Dubai',hoursByDay,weeklyHoursConfirmed:input.weeklyHoursConfirmed===true,holidayCalendarConfirmed:input.holidayCalendarConfirmed===true,confirmed:input.confirmed===true&&input.holidayCalendarConfirmed===true,workingDays:input.workingDays,holidays:[...new Set(input.holidays)],authority:String(input.authority||'').slice(0,500),effectiveFrom:input.effectiveFrom||null};
}
function duration(start,end,calendar){
 const elapsedSeconds=(time(end)-time(start))/1000;
 if(!Number.isFinite(elapsedSeconds)||elapsedSeconds<0)return {elapsedSeconds:null,businessSeconds:null,windowOnlySeconds:null,status:'unmeasurable'};
 const applicable=calendar?.confirmed===true&&calendar.holidayCalendarConfirmed!==false&&time(calendar.effectiveFrom)<=time(start);
 const provisional=calendar?.weeklyHoursConfirmed?{...calendar,confirmed:true,holidayCalendarConfirmed:true,holidays:calendar.holidayCalendarConfirmed?calendar.holidays:[]}:windowCalendar;
 return {elapsedSeconds,businessSeconds:applicable?businessSeconds(start,end,calendar):null,windowOnlySeconds:time(start)>=time(provisional.effectiveFrom||'2026-08-08T00:00:00+04:00')?businessSeconds(start,end,provisional):null,status:applicable?'confirmed_calendar':'provisional_window_only'};
}
function excluded(message){return message.internalNote===true||message.sourceMetadata?.nativeEvent?.kind==='internal_note'||message.display?.automatedReply===true||['reaction','internal_note'].includes(message.sourceMetadata?.nativeContent?.kind)||message.authorType==='system'||message.authorType==='bot'||message.authorType==='automated';}
export function measureRequest(request,messages,{calendar=null,asOf=new Date().toISOString(),replyUseCounts={}}={}){
 const linked=new Set((request.evidenceMessageIds||[]).map(ref));
 const rows=messages.filter(m=>linked.has(ref(m._id))).sort((a,b)=>time(a.sentAt)-time(b.sentAt)||ref(a._id).localeCompare(ref(b._id)));
 const nonCustomer=['spam','vendor','non_customer'].includes(request.classification?.kind);
 const episodes=[],excludedIds=[],unknownIds=[];let episode=null;
 for(const m of rows){
  if(!Number.isFinite(time(m.sentAt))||time(m.sentAt)>time(asOf)){unknownIds.push(ref(m._id));continue;}
  if(nonCustomer||excluded(m)){excludedIds.push(ref(m._id));continue;}
  if(m.authorType==='customer'){
   if(!episode)episode={kind:episodes.length?'subsequent':'first',startedAt:m.sentAt,customerMessageIds:[],uncertain:false};
   episode.customerMessageIds.push(ref(m._id));continue;
  }
  if(isServiceStaffReply(m)){
   if(!episode)continue;
   const shared=(replyUseCounts[ref(m._id)]||0)>1;
   const result={...episode,replyMessageId:ref(m._id),repliedAt:m.sentAt,staffAuthorId:m.externalAuthorId||m.authorId||null,...duration(episode.startedAt,m.sentAt,calendar)};
   result.state=episode.uncertain||shared||!result.staffAuthorId?'unmeasurable':'answered';
   result.reason=shared?'Reply linked to multiple requests; attribution needs review':episode.uncertain?'Unknown author within linked response episode':!result.staffAuthorId?'Human actor identifier unavailable':null;
   if(result.state!=='answered'){result.businessSeconds=null;result.windowOnlySeconds=null;}
   episodes.push(result);episode=null;continue;
  }
  unknownIds.push(ref(m._id));if(episode)episode.uncertain=true;
 }
 if(episode){const closed=['resolved','non_customer'].includes(request.status);episodes.push({...episode,state:closed||episode.uncertain?'unmeasurable':'pending',reason:closed?'Resolved without a linked recorded human reply':episode.uncertain?'Uncertain author attribution':'Awaiting an explicitly linked human reply',...duration(episode.startedAt,asOf,calendar)});}
 const history=[...(request.history||[])].filter(h=>time(h.at)<=time(asOf)).sort((a,b)=>time(a.at)-time(b.at));
 const assignments=history.filter(h=>h.after?.ownerId&&ref(h.after.ownerId)!==ref(h.before?.ownerId));
 const firstAssignment=assignments[0]?.at||(!history.length?request.assignedAt:null);
 const ownership=[],waiting=[];let owner=null,ownerStart=request.receivedAt,wait=null;
 for(const h of history){const next=h.after?.ownerId?ref(h.after.ownerId):null;if(h.after&&next!==owner){if(time(h.at)>=time(ownerStart))ownership.push({ownerId:owner,from:ownerStart,to:h.at,...duration(ownerStart,h.at,calendar)});owner=next;ownerStart=h.at;}
  const team=h.after?.waitingOn||'';if(h.after&&team!==(wait?.team||'')){if(wait)waiting.push({...wait,to:h.at,...duration(wait.from,h.at,calendar)});wait=team?{team,from:h.at}:null;}
 }
 if(history.length)ownership.push({ownerId:owner,from:ownerStart,to:asOf,...duration(ownerStart,asOf,calendar)});
 if(wait)waiting.push({...wait,to:asOf,...duration(wait.from,asOf,calendar)});
 const followups=(request.followups||[]).map(f=>({id:f.id,responsibleId:ref(f.responsibleId)||null,dueAt:f.dueAt,completedAt:f.completedAt||null,state:!Number.isFinite(time(f.dueAt))?'unknown':f.status==='completed'?Number.isFinite(time(f.completedAt))?(time(f.completedAt)<=time(f.dueAt)?'completed_on_time':'completed_late'):'unknown':time(f.dueAt)<time(asOf)?'overdue':'due',evidenceMessageIds:(f.evidenceMessageIds||[]).map(ref)}));
 const missing=[...linked].filter(id=>!rows.some(m=>ref(m._id)===id));
 return {version:REQUEST_METRICS_VERSION,requestId:ref(request._id),conversationId:ref(request.conversationId),asOf,calendar:{confirmed:calendar?.confirmed===true,version:calendar?.version||0,timezone:'Asia/Dubai',window:(calendar?.hoursByDay?calendar.workingDays.map(day=>`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]} ${hourLabel(calendar.hoursByDay[day].start)}–${hourLabel(calendar.hoursByDay[day].end)}`).join(' · '):'Mon–Thu 08:00–17:00; Fri–Sun 09:00–18:00'),effectiveFromBasis:calendar?.effectiveFromBasis||'Configured effective date',status:calendar?.confirmed?'Effective-date eligibility applies':'Weekly hours confirmed; holidays unconfirmed. Window-only figures are provisional'},requestEligibility:nonCustomer?'excluded_non_customer':'customer_request',coverage:'Explicit linked evidence only; source history may be incomplete',episodes,counts:{eligible:episodes.length,answered:episodes.filter(e=>e.state==='answered').length,pending:episodes.filter(e=>e.state==='pending').length,unmeasurable:episodes.filter(e=>e.state==='unmeasurable').length,unmeasurableTiming:episodes.filter(e=>e.state==='answered'&&e.businessSeconds==null&&e.windowOnlySeconds==null).length,excludedMessages:excludedIds.length,unknownMessages:unknownIds.length,missingEvidence:missing.length},excludedMessageIds:excludedIds,unknownMessageIds:unknownIds,missingMessageIds:missing,assignment:{start:request.receivedAt,assignedAt:firstAssignment||null,state:firstAssignment?'assigned':request.ownerId?'unmeasurable':'pending',...duration(request.receivedAt,firstAssignment||asOf,calendar)},ownershipIntervals:ownership,ownershipCoverage:history.length?'Recorded changes only':'No ownership history available',waitingIntervals:waiting,resolution:{basis:request.resolution?.basis||null,at:request.resolution?.at||null,state:['resolved','non_customer'].includes(request.status)?request.resolution?.at?'resolved':'unmeasurable':'pending',...duration(request.receivedAt,['resolved','non_customer'].includes(request.status)?request.resolution?.at:asOf,calendar),activeSeconds:null,activeTimePolicy:'Waiting is shown separately; no adjusted active-time policy has been approved'},followups,reopens:history.filter(h=>['link_message','work'].includes(h.event)&&['resolved','non_customer'].includes(h.before?.status)&&h.after?.status==='open').map(h=>({at:h.at,reason:h.reason,actorId:ref(h.actorId)}))};
}
const signals=[
 ['renewal',/\brenew(?:al|ing)?\b/i,'Confirm the requested renewal and terms'],['plan_change',/\b(upgrade|change (?:my |the )?plan)\b/i,'Confirm the requested plan change'],['pause',/\b(pause|skip|hold deliveries)\b/i,'Confirm the requested dates'],['refund',/\b(refund|cancel(?:lation)?|money back)\b/i,'Check cancellation or refund authority'],['meal_selection',/\b(select(?:ion)?|choose|chose)\b.{0,30}\bmeal|\bmeal.{0,30}\bselect/i,'Check the recorded meal selections'],['delivery_missed',/\b(late|missed|missing|not arrived|didn.t arrive|not delivered)\b/i,'Verify the delivery and agreed remedy'],['delivery_instructions',/\b(address|location|building|door|gate|delivery instructions)\b/i,'Verify the requested delivery instructions'],['bag_collection',/\b(bag|cooler|ice pack)\b/i,'Confirm bag collection details'],['food_quality',/\b(spoiled|mould|mold|hair|raw|food poisoning|sick|hygiene|food quality)\b/i,'Escalate the recorded food-quality concern for review'],['exclusions',/\b(allerg|exclude|exclusion|no nuts|gluten|dairy)/i,'Verify exclusions against the customer request'],['nutrition',/\b(calorie|macro|protein|nutrition|carb)/i,'Check the requested nutrition information'],['discount',/\b(discount|promo|partner code|coupon)\b/i,'Check the offered discount terms'],['new_lead',/\b(interested|new customer|sign up|start a plan)\b/i,'Clarify the requested plan'],['returning_lead',/\b(returning|come back|restart|subscribe again)\b/i,'Confirm the returning customer request'],['billing',/\b(payment|charged|invoice|billing|receipt)\b/i,'Verify the billing evidence'],['feedback',/\b(feedback|suggestion|feature request)\b/i,'Record and route the feedback'],['other',/\b(other request|something else)\b/i,'Clarify the request before classifying']];
export function suggestRequest(request,messages){
 const linked=new Set((request.evidenceMessageIds||[]).map(ref));const rows=messages.filter(m=>linked.has(ref(m._id))&&m.authorType==='customer'&&!excluded(m));
 const candidates=signals.map(([topic,pattern,followup])=>{const matches=rows.filter(m=>pattern.test(m.text||''));return matches.length?{topic,label:REQUEST_TOPICS.find(t=>t.id===topic).label,kind:matches.some(m=>/\b(not|wrong|late|missing|problem|refund|sick|spoiled)\b/i.test(m.text||''))?'complaint':'inquiry',evidenceMessageIds:matches.map(m=>ref(m._id)),evidence:matches.map(m=>({id:ref(m._id),text:(m.text||'').slice(0,240)})),followup,urgency:topic==='food_quality'?'Needs prompt staff assessment':'Not established',uncertainty:'Keyword suggestion; staff must verify meaning and context'}:null;}).filter(Boolean);
 return {version:SUGGESTION_VERSION,candidates:candidates.map(c=>({...c,requiresTopicSelection:true,id:createHash('sha256').update(JSON.stringify({version:SUGGESTION_VERSION,requestId:ref(request._id),topic:c.topic,evidence:rows.filter(m=>c.evidenceMessageIds.includes(ref(m._id))).map(m=>[ref(m._id),m.text||''])})).digest('hex')})),coverage:'English keyword rules only. Choose the current Topic and Issue detail before applying a suggested area; absence of a suggestion is not an absence of an issue',noAutomaticActions:true};
}
export function summarizeRequestMetrics(metrics){
 const episodes=metrics.flatMap(m=>m.episodes),mean=rows=>rows.length?rows.reduce((n,x)=>n+x,0)/rows.length:null;
 const summarize=kind=>{const rows=episodes.filter(e=>e.kind===kind),answered=rows.filter(e=>e.state==='answered'),confirmed=answered.filter(e=>e.businessSeconds!==null).map(e=>e.businessSeconds),provisional=answered.filter(e=>e.businessSeconds===null&&e.windowOnlySeconds!==null).map(e=>e.windowOnlySeconds);return {eligible:rows.length,answered:answered.length,pending:rows.filter(e=>e.state==='pending').length,unmeasurable:rows.filter(e=>e.state==='unmeasurable').length,confirmedSamples:confirmed.length,averageBusinessSeconds:mean(confirmed),provisionalSamples:provisional.length,averageWindowOnlySeconds:mean(provisional)};};
 const followups=metrics.flatMap(m=>m.followups);return {first:summarize('first'),subsequent:summarize('subsequent'),followups:Object.fromEntries(['due','overdue','completed_on_time','completed_late','unknown'].map(state=>[state,followups.filter(f=>f.state===state).length])),reopens:metrics.reduce((n,m)=>n+m.reopens.length,0),scope:'Current report page only; no staff ranking or population-wide claim'};
}
