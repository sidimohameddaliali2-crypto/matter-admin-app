import React from 'react';
import {formatDubai,idOf} from './serviceUtils';

export const issueNext=request=>(request.followups||[]).filter(f=>f.status!=='completed').sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt))[0]||request.nextAction;
export function hasIssueDraft(actorId,conversationId,id){
 try{return Boolean(sessionStorage.getItem(`matter:action-draft:${actorId}:${conversationId}:${id}`)||sessionStorage.getItem(`matter:action-draft:${actorId}:${conversationId}:${id}:reopen`)||JSON.parse(sessionStorage.getItem(`matter:request-draft:${actorId}:${conversationId}`))?.drafts?.['request:'+id]);}catch{return false;}
}
export function hasReopenDraft(actorId,conversationId,id){try{const base=`matter:action-draft:${actorId}:${conversationId}:${id}`,legacy=JSON.parse(sessionStorage.getItem(base));return Boolean(sessionStorage.getItem(base+':reopen')||legacy?.fields?.reopenReason||legacy?.fields?.reopenMessageId);}catch{return false;}}
export default function IssueOverview({requests=[],counts,selectedId,actorId,conversationId,owners=[],onSelect,compact=false,onAdd,heading}){
 const issues=requests.filter(r=>r.status!=='non_customer'),total=counts?Number(counts.open||0)+Number(counts.resolved||0):issues.length||null;
 const visible=compact?[issues.find(r=>r._id===selectedId)||issues.find(r=>r.status!=='resolved')||issues[0]].filter(Boolean):issues;
 return <section className={compact?'cs-mobile-issue-summary':'cs-issue-overview'} aria-label={compact?'Current issue summary':heading||'Conversation issues'}><strong>{heading||(total==null?'Issues':total===1?'1 issue':total+' issues')}</strong>{visible.length?visible.map(r=>{const next=issueNext(r),closed=r.status==='resolved';return <button type="button" key={r._id} aria-pressed={r._id===selectedId} onClick={()=>onSelect(r)}><span className="cs-overview-title">{r.title||r.excerpt}{hasIssueDraft(actorId,conversationId,r._id)&&<em>Draft</em>}</span><span>{owners.find(o=>idOf(o.userId||o)===idOf(r.ownerId))?.displayName||(r.ownerId?'Recorded staff':'Unassigned')} · {closed?'Resolved':r.waitingOn?'Waiting for '+r.waitingOn:r.status==='waiting'?'Waiting':'Open'}</span><span>{closed?r.resolution?.outcomeLabel||'Recorded outcome':next?.action||'Next step not recorded'}{!closed&&next?.dueAt?' · Follow-up due '+formatDubai(next.dueAt):''}</span></button>;}):onAdd&&<button type="button" onClick={onAdd}>+ Add issue</button>}</section>;
}
