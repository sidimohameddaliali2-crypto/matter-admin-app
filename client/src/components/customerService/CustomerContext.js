import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import Conversation from './Conversation';
import ReviewHistory from './ReviewHistory';
import { categoryLabels, formatDubai, idOf, prettyStatus, ResourceState, useServiceResource } from './serviceUtils';

function CustomerContext({ customerId, customerName, issues = [], categories = [], capabilities, currentUserId }) {
  const context = useServiceResource(customerId ? `/customers/${encodeURIComponent(customerId)}/context` : null);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const conversation = useServiceResource(selectedIssue ? `/issues/${encodeURIComponent(selectedIssue)}` : null);
  const data = context.data;
  const subscription = data?.subscription;
  return <><section className="cs-card"><p className="cs-eyebrow">Matter customer context</p><h2>{data?.customer?.name || customerName || 'Customer'}</h2><p className="cs-muted">{customerId || 'No linked Matter customer ID'}</p><ResourceState loading={context.loading} error={context.error} />
    {!customerId && <div className="cs-notice">This captured conversation is not linked to a Matter customer. No identity is guessed from the name.</div>}
    {data && <><div className={data.sourceState === 'available' ? 'cs-success' : 'cs-notice'}>{data.message || (data.sourceState === 'available' ? 'Available customer context loaded.' : 'Current source context is unavailable.')}</div><dl className="cs-context-list"><dt>Source state</dt><dd>{prettyStatus(data.sourceState)}</dd><dt>Observed at</dt><dd>{formatDubai(data.observedAt || data.fetchedAt)}</dd>{subscription && <><dt>Subscription</dt><dd>{subscription.status || subscription.subscriptionStatus || 'Status not supplied'}</dd>{(subscription.planName || subscription.name) && <><dt>Plan</dt><dd>{subscription.planName || subscription.name}</dd></>}{(subscription.startDate || subscription.startsAt) && <><dt>Start</dt><dd>{formatDubai(subscription.startDate || subscription.startsAt)}</dd></>}</>}</dl>{!subscription && <p className="cs-muted" style={{ marginTop: 12 }}>Subscription history is not available in this response. Current status alone cannot verify a historical requested change.</p>}</>}
    <p className="cs-muted" style={{ marginTop: 16 }}>Context is read-only. A review does not change subscriptions, deliveries, billing or the source inbox.</p></section>
    <section className="cs-card"><h3>Linked issues and chats</h3>{issues.length ? issues.map(issue => <div key={idOf(issue)} style={{ padding: '12px 0', borderBottom: '1px solid #eceef1' }}><strong>{issue.summary || 'Captured issue'}</strong><p className="cs-muted">{categoryLabels(issue.categoryIds, categories)} · {prettyStatus(issue.outcome)}</p><button onClick={() => setSelectedIssue(idOf(issue))}>View captured conversation</button></div>) : <p className="cs-muted">No issues are available in your service scope.</p>}</section>
    {selectedIssue && <><ResourceState loading={conversation.loading} error={conversation.error}/>{conversation.data && <><Conversation issue={conversation.data.issue} messages={conversation.data.messages || []} /><ReviewHistory reviews={conversation.data.reviews || []} capabilities={capabilities} currentUserId={currentUserId} onChanged={conversation.refresh}/></>}</>}
  </>;
}

export default function CustomerContextDrawer({ customerId, customerName, issues, categories, capabilities, currentUserId, onClose }) {
  const close = useRef(null);
  const panel = useRef(null);
  useEffect(() => {
    const previous = document.activeElement; close.current?.focus();
    const keydown = event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const focusable = panel.current?.querySelectorAll('button:not(:disabled), a[href], input, select, textarea, summary, [tabindex="0"]');
        if (!focusable?.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus?.(); };
  }, [onClose]);
  return <div className="cs-drawer-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><aside className="cs-drawer" role="dialog" aria-modal="true" aria-label="Customer context" ref={panel}><div className="cs-toolbar"><h3>Customer context</h3><button ref={close} onClick={onClose} aria-label="Close customer context"><X size={18}/></button></div><CustomerContext customerId={customerId} customerName={customerName} issues={issues} categories={categories} capabilities={capabilities} currentUserId={currentUserId}/></aside></div>;
}
