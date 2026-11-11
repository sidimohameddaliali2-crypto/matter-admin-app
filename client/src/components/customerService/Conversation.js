import ServiceMedia from './ServiceMedia';
import React, {useState} from 'react';
import { formatDubai, idOf, isStaffReply } from './serviceUtils';

const initial = name => String(name || '?').split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
const dayFormatter = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'});
const timeFormatter = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const dateFormatter = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',day:'numeric',month:'short',year:'numeric'});
const dayOf = value => Number.isFinite(new Date(value).getTime()) ? dayFormatter.format(new Date(value)) : '';
const timeOf = value => Number.isFinite(new Date(value).getTime()) ? timeFormatter.format(new Date(value)) : '';
// Render a small subset of WhatsApp emphasis as React nodes, never source HTML.
function MessageText({text}) {
  return String(text||'').split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g).map((part,i)=>{
    if(part.startsWith('**')&&part.endsWith('**'))return <strong key={i}>{part.slice(2,-2)}</strong>;
    if(part.startsWith('*')&&part.endsWith('*')&&part.length>2)return <strong key={i}>{part.slice(1,-1)}</strong>;
    if(part.startsWith('_')&&part.endsWith('_')&&part.length>2)return <em key={i}>{part.slice(1,-1)}</em>;
    if(part.startsWith('~')&&part.endsWith('~')&&part.length>2)return <del key={i}>{part.slice(1,-1)}</del>;
    return part;
  });
}

export default function Conversation({ messages = [], issue, conversationId, onRequest, sourceDetails=false,highlightMessageId,onReopen,reopenAfter,reopenIssueTitle }) {
  const [localDetails,setShowDetails]=useState(false);
  const showDetails=sourceDetails||localDetails;
  const native=Boolean(conversationId),today=dayOf(new Date());
  let waitingSince = null, firstHumanSeen = false, previousThread=null;
  return <section className={`cs-card cs-conversation ${native?'cs-chat':''}`} aria-label="Captured conversation">
    {!native&&<><p className="cs-eyebrow">Messages · Dubai</p><h2>{issue?.summary || 'Customer conversation'}</h2><p className="cs-muted">{issue?.customerName || 'Customer name not recorded'}{issue?.customerId ? ` · ${issue.customerId}` : ''}</p><hr className="cs-divider"/></>}
    {native&&<div className="cs-chat-tools"><button type="button" aria-pressed={showDetails} onClick={()=>setShowDetails(!showDetails)}>{showDetails?'Hide source details':'Show source details'}</button></div>}
    {messages.some(m=>m.source==='gallabox_history')&&<p className="cs-notice">Historical transcript · conversation grouping unverified.</p>}
    {messages.some(m=>m.externalConversationId?.startsWith('unthreaded:'))&&<p className="cs-muted">Some messages have no source conversation ID.</p>}
    {!messages.length && <div className="cs-notice">No captured messages.</div>}
    {messages.map((message,index)=>{
      const previous=messages[index-1],thread=message.externalConversationId;
      const threadChanged=Boolean(previousThread&&thread&&previousThread!==thread);
      if(threadChanged){waitingSince=null;firstHumanSeen=false;}
      if(thread)previousThread=thread;
      const day=dayOf(message.sentAt),dayChanged=native&&day&&day!==dayOf(previous?.sentAt);
      const dateLabel=!day?'':day===today?'Today':dateFormatter.format(new Date(message.sentAt));
      const divider=dayChanged?<div className="cs-day-divider"><span>{dateLabel}</span></div>:null;
      if(message.authorType==='system')return <React.Fragment key={idOf(message)||index}>{divider}<details id={`cs-message-${idOf(message)}`} className="cs-system-event"><summary>{message.display?.eventLabel||'Conversation activity'} · {native?timeOf(message.sentAt):formatDubai(message.sentAt)}</summary><p>Gallabox system event{message.display?.eventAction?` · ${message.display.eventAction}`:''}</p><small>Source reference: {message.externalMessageId||'Not recorded'}</small></details></React.Fragment>;
      const content=message.display?.nativeContent;
      if(content?.kind==='reaction')return <React.Fragment key={idOf(message)||index}>{divider}<details id={`cs-message-${idOf(message)}`} className="cs-system-event"><summary>{message.authorName||'Reaction'} · {content.emoji===''?'Reaction removed':content.emoji||'Reaction'} · {timeOf(message.sentAt)}</summary>{content.text&&<p><MessageText text={content.text}/></p>}<small>Source reaction</small></details></React.Fragment>;
      const internalNote=message.internalNote===true,automatic=message.display?.automatedReply===true||message.authorType==='bot';
      const staff=isStaffReply(message),staffAuthor=message.authorType==='staff',unknown=!automatic&&(!message.authorType||message.authorType==='unknown');
      const outgoing=!internalNote&&(staffAuthor||automatic||message.display?.direction==='outgoing');
      const time=new Date(message.sentAt).getTime();
      if(!internalNote&&message.authorType==='customer'&&waitingSince==null&&Number.isFinite(time))waitingSince=time;
      let wait=null;
      if(staff&&waitingSince!=null&&Number.isFinite(time)&&time>=waitingSince){const minutes=Math.round((time-waitingSince)/60000);wait=`${firstHumanSeen?'Next human reply':'First captured human reply'}: ${minutes<1?'under 1 min':`${minutes} min`} elapsed`;firstHumanSeen=true;waitingSince=null;}
      const name=automatic?'Automatic reply':message.authorName||(unknown?'Unknown author':staffAuthor?'Recorded staff author':'Customer');
      const continued=native&&!dayChanged&&!threadChanged&&previous?.authorType!=='system'&&previous?.authorType===message.authorType&&Boolean(previous?.internalNote)===internalNote&&Boolean(previous?.display?.automatedReply||previous?.authorType==='bot')===automatic&&(previous?.display?.nativeContent?.kind==='template')===(content?.kind==='template')&&(previous?.externalAuthorId||previous?.authorName||'')===(message.externalAuthorId||message.authorName||'')&&time-new Date(previous?.sentAt).getTime()<300000;
      const nonText=message.type&&message.type!=='text';
      return <React.Fragment key={idOf(message)||index}>{divider}
        {native&&threadChanged&&message.authorType!=='system'&&<div className="cs-thread-divider">New conversation</div>}
        {!native&&wait&&<div className="cs-wait"><span>{wait}</span></div>}
        <article id={`cs-message-${idOf(message)}`} tabIndex={-1} className={`cs-message ${native?(internalNote?'system':outgoing?'outgoing':'incoming'):(staff?'staff':automatic||internalNote?'system':'')} ${automatic?'automatic':''} ${continued?'continued':''} ${idOf(message)===highlightMessageId?'cs-evidence-target':''}`}>
          <div className="cs-avatar" aria-hidden="true">{automatic?'A':initial(name)}</div>
          <div className="cs-message-body">
            {(!continued||showDetails)&&<div className="cs-message-meta"><strong>{name}</strong>{!native&&` · ${formatDubai(message.sentAt)}`}{content?.kind==='template'?' · Template':internalNote?' · Internal note':!native&&staff?' · source responder':!native&&automatic?' · automated':unknown?' · identity unverified':''}</div>}
            <div className="cs-bubble">{message.display?.replyContext&&<blockquote className="cs-reply-context"><small>Replying to</small><div><MessageText text={message.display.replyContext.text||`[${message.display.replyContext.type||'message'}]`}/></div></blockquote>}{content?.headerText&&<strong>{content.headerText}<br/></strong>}<MessageText text={message.text||content?.text||(!nonText?'No text captured':'')}/>{content?.contacts?.map((card,i)=><div className="cs-shared-contact" key={i}><strong>{card.name||'Shared contact'}</strong>{card.phones.map((phone,j)=><div key={j}>{phone}</div>)}</div>)}{content?.buttons?.length>0&&<div className="cs-template-options">{content.buttons.map((label,i)=><span key={i}>{label}</span>)}</div>}{nonText&&<ServiceMedia message={message} issue={issue} conversationId={native?(idOf(message.conversationId)||conversationId):undefined}/>}{native&&<time className="cs-message-time" dateTime={message.sentAt} title={formatDubai(message.sentAt)}>{timeOf(message.sentAt)}</time>}</div>
            <div className="cs-message-actions">{onRequest&&(message.authorType==='customer'||staff)&&message.internalNote!==true&&<button className="cs-message-request" onClick={()=>onRequest(message)}>{staff?'Link human reply':'Use this message'}</button>}{onReopen&&message.authorType==='customer'&&!internalNote&&(!reopenAfter||Date.parse(message.sentAt)>Date.parse(reopenAfter))&&<button className="cs-message-reopen" aria-label={`Reopen ${reopenIssueTitle||'this issue'} from this message`} onClick={()=>onReopen(message)}>Reopen this issue</button>}</div>{(!native||showDetails)&&<details className="cs-source-reference"><summary className="cs-muted">Source reference</summary><p className="cs-muted">Message {message.externalMessageId||'source ID not captured'} · Author {message.externalAuthorId||message.authorId||'ID not captured'}</p></details>}
          </div>
        </article>
      </React.Fragment>;
    })}
    {!native&&waitingSince!=null&&<div className="cs-notice">No subsequent human reply is present in this capture.</div>}
    {(!native||showDetails)&&<details><summary>About these messages</summary><p className="cs-muted">Partial capture. Reply times are elapsed time, not business hours.</p></details>}
  </section>;
}
