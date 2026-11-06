import React from 'react';
import { formatDubai, idOf } from './serviceUtils';

const initial = name => String(name || '?').split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();

export default function Conversation({ messages = [], issue }) {
  let waitingSince = null;
  let firstHumanSeen = false;
  return <section className="cs-card cs-conversation" aria-label="Captured conversation"><p className="cs-eyebrow">Recorded source messages · Dubai time</p><h2>{issue?.summary || 'Customer conversation'}</h2><p className="cs-muted">{issue?.customerName || 'Customer name not recorded'}{issue?.customerId ? ` · ${issue.customerId}` : ''}</p><hr className="cs-divider"/>
    {!messages.length && <div className="cs-notice">No message evidence is available for this issue. Do not infer how it was handled.</div>}
    {messages.map((message, index) => {
      const staff = message.authorType === 'staff';
      const bot = message.authorType === 'bot' || message.authorType === 'system';
      const unknown = !message.authorType || message.authorType === 'unknown';
      const time = new Date(message.sentAt).getTime();
      if (message.authorType === 'customer' && waitingSince == null && Number.isFinite(time)) waitingSince = time;
      let wait = null;
      if (staff && waitingSince != null && Number.isFinite(time) && time >= waitingSince) {
        const minutes = Math.round((time - waitingSince) / 60000);
        wait = `${firstHumanSeen ? 'Next human reply' : 'First captured human reply'}: ${minutes < 1 ? 'under 1 min' : `${minutes} min`} elapsed`;
        firstHumanSeen = true; waitingSince = null;
      }
      const name = message.authorName || (unknown ? 'Unknown author' : bot ? 'Automated message' : staff ? 'Recorded staff author' : 'Customer');
      const nonText = message.type && message.type !== 'text';
      return <React.Fragment key={idOf(message) || index}>{wait && <div className="cs-wait"><span>{wait}</span></div>}<article id={`cs-message-${idOf(message)}`} className={`cs-message ${staff ? 'staff' : bot ? 'system' : ''}`}><div className="cs-avatar" aria-hidden="true">{initial(name)}</div><div><div className="cs-message-meta"><strong>{name}</strong> · {formatDubai(message.sentAt)}{staff ? ' · source responder' : bot ? ' · automated' : unknown ? ' · identity unverified' : ''}</div><div className="cs-bubble">{message.text || (!nonText ? 'No text captured' : '')}{nonText && <div className="cs-muted" style={{ marginTop: message.text ? 7 : 0 }}>{String(message.type).replace(/_/g, ' ')} attachment · {message.mediaState || 'availability unknown'}. Playback or file content is not available in this capture.</div>}</div><details style={{ border: 0, paddingTop: 4 }}><summary className="cs-muted">Source reference</summary><p className="cs-muted">Message {message.externalMessageId || 'source ID not captured'} · Author {message.externalAuthorId || message.authorId || 'ID not captured'}</p></details></div></article></React.Fragment>;
    })}
    {waitingSince != null && <div className="cs-notice">No subsequent human reply is present in the captured messages. Capture completeness is not proof of an unanswered live inbox.</div>}
    <hr className="cs-divider"/><p className="cs-muted">Elapsed waits use captured customer and human message times. They do not measure business hours or assignment response time. Missing attachments and source history remain unknown.</p>
  </section>;
}
