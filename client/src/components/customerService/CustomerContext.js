import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import Conversation from './Conversation';
import ReviewHistory from './ReviewHistory';
import { categoryLabels, filterParams, formatDubai, idOf, prettyStatus, ResourceState, useServiceResource } from './serviceUtils';

const subscriptionDate = value => {
  if (!value || Number.isNaN(new Date(value).getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Dubai',day:'numeric',month:'short',year:'numeric'}).format(new Date(value));
};
export function SubscriptionList({subscriptions = [], compact = false}) {
  if (!subscriptions.length) return <p className="cs-muted">No subscription recorded.</p>;
  if (compact && subscriptions.length) return <details><summary>{subscriptions[0].planName || subscriptions[0].name || 'Subscription'} · {prettyStatus(subscriptions[0].status || subscriptions[0].subscriptionStatus)}{subscriptions.length > 1 ? ` +${subscriptions.length-1}` : ''}</summary><SubscriptionList subscriptions={subscriptions}/></details>;
  return <div>{subscriptions.map((subscription,index)=><div key={subscription.subscriptionId || subscription.id || index} style={{marginBottom:8}}><strong>{subscription.planName || subscription.name || 'Plan not supplied'}</strong><p className="cs-muted">{prettyStatus(subscription.status || subscription.subscriptionStatus || 'status not supplied')}</p><p className="cs-muted">Start {subscriptionDate(subscription.startDate || subscription.startsAt)} · End {subscriptionDate(subscription.endDate || subscription.endsAt)}</p></div>)}</div>;
}
function CustomerContext({ customerId, customerName, issues = [], categories = [], capabilities, currentUserId, matchState, filters = {} }) {
  const context = useServiceResource(customerId ? `/customers/${encodeURIComponent(customerId)}/context` : null, filterParams({from:filters.from,to:filters.to,categoryId:filters.categoryId}));
  const [selectedIssue, setSelectedIssue] = useState(null);
  const conversation = useServiceResource(selectedIssue ? `/issues/${encodeURIComponent(selectedIssue)}` : null);
  const data = context.data;
  const scopedIssues = data?.issues || issues;
  const subscriptions = Array.isArray(data?.subscriptions) ? data.subscriptions : data?.subscription ? [data.subscription] : [];
  const sourceState = data?.source?.state || data?.sourceState;
  const observedAt = data?.source?.observedAt || data?.observedAt || data?.fetchedAt;
  return <><section className="cs-card"><p className="cs-eyebrow">{customerId ? 'Matter customer context' : 'Unmatched source contact'}</p><h2>{data?.customer?.name || customerName || 'Customer'}</h2><p className="cs-muted">{customerId || 'No linked Matter customer ID'}{(data?.matchState || matchState) ? ` · ${prettyStatus(data?.matchState || matchState)}` : ''}</p><ResourceState loading={context.loading} error={context.error}/>
    {context.error && <button onClick={context.refresh}>Retry customer context</button>}
    {!customerId && <div className="cs-notice">Unmatched contact. No identity is guessed.</div>}
    {data && <><details><summary>Source details · {prettyStatus(sourceState)}</summary><div>{data.source?.message || data.message || (sourceState === 'available' ? 'Available customer context loaded.' : 'Current source context is unavailable.')}</div></details>{sourceState !== 'available' && <p className="cs-notice">{sourceState === 'partial' ? data.source?.message || data.message || 'API updated · database unavailable' : 'Saved data · source unavailable.'}</p>}<dl className="cs-context-list"><dt>Source state</dt><dd>{prettyStatus(sourceState)}</dd><dt>Observed at</dt><dd>{formatDubai(observedAt)}</dd>{data.customer?.email && <><dt>Email</dt><dd>{data.customer.email}</dd></>}{data.customer?.phone && <><dt>Phone</dt><dd>{data.customer.phone}</dd></>}</dl><h3 style={{marginTop:16}}>Subscriptions</h3><SubscriptionList subscriptions={subscriptions}/></>}
    <p className="cs-muted" style={{ marginTop: 16 }}>Read-only</p></section>
    <section className="cs-card"><h3>{customerId ? 'Linked issues and chats' : 'Unmatched issues and chats'}</h3>{scopedIssues.length ? scopedIssues.map(issue => <div key={idOf(issue)} style={{ padding: '12px 0', borderBottom: '1px solid #eceef1' }}><strong>{issue.summary || 'Captured issue'}</strong><p className="cs-muted">{categoryLabels(issue.categoryIds, categories)} · {prettyStatus(issue.outcome)}</p><button onClick={() => setSelectedIssue(idOf(issue))}>View captured conversation</button></div>) : <p className="cs-muted">No chats in this scope.</p>}</section>
    {selectedIssue && <><ResourceState loading={conversation.loading} error={conversation.error}/>{conversation.data && <><Conversation issue={conversation.data.issue} messages={conversation.data.messages || []}/><ReviewHistory reviews={conversation.data.reviews || []} capabilities={capabilities} currentUserId={currentUserId} onChanged={conversation.refresh}/></>}</>}
  </>;
}

export default function CustomerContextDrawer({ customerId, customerName, issues, categories, capabilities, currentUserId, matchState, filters = {}, onClose }) {
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
  return <div className="cs-drawer-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><aside className="cs-drawer" role="dialog" aria-modal="true" aria-label="Customer context" ref={panel}><div className="cs-toolbar"><h3>Customer context</h3><button ref={close} onClick={onClose} aria-label="Close customer context"><X size={18}/></button></div><CustomerContext customerId={customerId} customerName={customerName} issues={issues} categories={categories} capabilities={capabilities} currentUserId={currentUserId} matchState={matchState} filters={filters}/></aside></div>;
}
