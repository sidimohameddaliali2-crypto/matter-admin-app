import React from 'react';
import {formatDubai,idOf} from './serviceUtils';
import {workflowTopic} from './requestTopics';

export default function OutcomeEvidence({request,definitions,owners,messages,onViewMessage}){
 const resolution=request.resolution;if(!resolution)return null;
 const previous=!['resolved','non_customer'].includes(request.status),message=messages.find(m=>idOf(m)===idOf(resolution.evidenceMessageId));
 const labels=definitions.actions?.[workflowTopic(request.classification,definitions)]?.flatMap(a=>a.outcomes||[]).flatMap(o=>o.fields||[])||[];
 return <section className="cs-outcome-details" aria-label={previous?'Previous outcome evidence':'Outcome evidence'}><h4>{previous?'Previous outcome':'Evidence'}</h4>{previous&&<p><strong>{resolution.outcomeLabel||resolution.note||'Recorded outcome'}</strong> · Issue reopened</p>}
  {Object.entries(resolution.details||{}).map(([name,value])=><p key={name}>{labels.find(f=>f.id===name)?.label||name.replace(/([a-z])([A-Z])/g,'$1 $2')}: {value===true?'Confirmed':String(value)}</p>)}
  {resolution.evidenceReference&&<p>{resolution.evidenceReference}</p>}
  {resolution.evidenceMessageId&&<div className="cs-outcome-message">{message?<><blockquote>{message.text||'Captured '+(message.type||'attachment')+' — open the message to inspect it'}</blockquote><small>{message.authorName||(message.authorType==='customer'?'Customer':'Recorded staff')} · {formatDubai(message.sentAt)}</small></>:<p>Linked message is outside the loaded transcript.</p>}<button type="button" onClick={()=>onViewMessage?.(idOf(resolution.evidenceMessageId))} disabled={!onViewMessage}>View message</button></div>}
  {!resolution.evidenceMessageId&&!resolution.evidenceReference&&resolution.note&&<p>{resolution.note}</p>}
  <small>Recorded by {owners.find(o=>idOf(o.userId||o)===idOf(resolution.actorId))?.displayName||'Recorded staff'} · {formatDubai(resolution.at)}</small>
 </section>;
}
