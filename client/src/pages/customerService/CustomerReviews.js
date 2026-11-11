import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import api from '../../utils/api';
import ReviewPanel from '../../components/customerService/ReviewPanel';
import Conversation from '../../components/customerService/Conversation';
import CustomerContextDrawer from '../../components/customerService/CustomerContext';
import { categoryLabels, errorMessage, filterParams, idOf, matchesIssue, newRequestId, prettyStatus, ResourceState, servicePath, unpack, useServiceResource } from '../../components/customerService/serviceUtils';

export default function CustomerReviews({ me, user, capabilities, categories, filters, epoch, onRefresh }) {
  const list = useServiceResource('/reviews', filterParams(filters), epoch);
  const issueList = useServiceResource(!capabilities.review ? '/issues' : null, filterParams(filters), epoch);
  const ownerList = useServiceResource(capabilities.review ? '/owners' : null, {}, epoch);
  const [active, setActive] = useState(null);
  const [readOnlyIssue, setReadOnlyIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [context, setContext] = useState(false);
  const currentUserId = idOf(me.profile?.userId || user?._id);
  const issueId = idOf(active?.issueId) || readOnlyIssue;
  const detail = useServiceResource(issueId ? `/issues/${encodeURIComponent(issueId)}` : null, {}, epoch);
  const lock = useRef(false);
  const request = useRef(null);
  const resumed = useRef(false);
  const issueForReview = review => typeof review?.issueId === 'object' ? review.issueId : review?.issue || {};
  const reviews = (list.data?.reviews || []).filter(review => idOf(review.reviewerId) === currentUserId);
  const visible = reviews.filter(review => matchesIssue(issueForReview(review), filters));
  const pending = visible.filter(review => ['assigned', 'in_review', 'pending'].includes(review.status));
  const reviewed = visible.filter(review => ['submitted', 'awaiting_evidence'].includes(review.status));
  useEffect(() => {
    if (resumed.current || !list.data) return;
    resumed.current = true;
    const unfinished = (list.data.reviews || []).find(review => idOf(review.reviewerId) === currentUserId && review.status === 'in_review');
    if (unfinished) setActive(unfinished);
  }, [list.data, currentUserId]);
  async function next({ saved = false } = {}) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    const claimFilters = filterParams(filters);
    const signature = JSON.stringify(claimFilters);
    if (!request.current || request.current.signature !== signature) request.current = {id:newRequestId(),signature};
    try {
      const data = unpack(await api.post(`${servicePath}/reviews/next`, { requestId: request.current.id, filters: claimFilters }));
      setActive(data?.review || null); setReadOnlyIssue(''); request.current = null;
      if (!data?.review) setNotice(saved ? 'Review saved. No next review is currently available.' : 'No reviews available.');
      else setNotice(saved ? 'Review saved. Your next case is ready.' : '');
      list.refresh(); if (idOf(data?.review?.issueId) === issueId) detail.refresh();
    } catch (failure) { setError(errorMessage(failure, 'The next review could not be loaded. Saved work is retained.')); }
    finally { lock.current = false; setBusy(false); }
  }
  async function submitted() { setActive(null); setNotice('Review saved. Loading the next available review…'); onRefresh(); await next({ saved: true }); }
  async function skipped() { setActive(null); setNotice('Review skipped.'); list.refresh(); onRefresh(); }
  const first = pending[0];
  const firstIssue = issueForReview(first);
  const activeIssue = detail.data?.issue;
  const outsideScope = Boolean(active && list.data && !(list.data.reviews || []).some(review => idOf(review) === idOf(active)));
  return <><ResourceState loading={list.loading} error={list.error}/>{error && <div className="cs-alert" role="alert">{error}</div>}{notice && <div className="cs-success" role="status">{notice}</div>}
    {outsideScope && <div className="cs-notice">Your open review is outside these filters. Change the dates to continue.</div>}
    {active && <div hidden={outsideScope} className="cs-toolbar"><div><p className="cs-eyebrow">My review</p><h3>{activeIssue?.customerName || 'Loading customer…'}</h3></div><div className="cs-form-actions"><button onClick={() => next()} disabled={busy}>Reload current review</button><button disabled={!activeIssue} onClick={() => setContext(true)}>View customer</button></div></div>}
    {issueId && <ResourceState loading={detail.loading} error={detail.error}/>}
    {active && detail.data && <div hidden={outsideScope} className="cs-grid"><Conversation issue={activeIssue} messages={detail.data.messages || []}/><ReviewPanel key={`${idOf(active)}-${active.sourceRevision}`} review={active} detail={detail.data} categories={categories} owners={ownerList.data?.owners || []} capabilities={capabilities} currentUserId={currentUserId} onSubmitted={submitted} onSkipped={skipped} onReviewChanged={review => { if (review) setActive(review); }} onReload={() => next()} /></div>}
    {active && detail.error && <section className="cs-card"><h3>Conversation evidence could not be loaded</h3><p className="cs-muted">Saved review retained.</p><button onClick={detail.refresh}>Reload conversation evidence</button></section>}
    {!active && capabilities.review && <div><section className="cs-card"><p className="cs-eyebrow">My reviews</p><h2>Your next review</h2><div className="cs-metrics"><div className="cs-metric"><strong>{list.data ? visible.length : '—'}</strong><span>Assigned</span></div><div className="cs-metric"><strong>{list.data ? reviewed.length : '—'}</strong><span>Reviewed</span></div><div className="cs-metric"><strong>{list.data ? pending.length : '—'}</strong><span>Remaining</span></div></div>
      {first ? <div className="cs-queue-hero"><h3>{firstIssue?.customerName || 'Assigned customer issue'}</h3><p>{categoryLabels(firstIssue?.categoryIds, categories)} · {prettyStatus(first.sampleType || 'routine review')}</p>{firstIssue?.summary && <blockquote>{firstIssue.summary}</blockquote>}<button className="cs-primary" onClick={() => next()} disabled={busy}>{busy ? 'Loading next review…' : 'Start next review'}<ArrowRight size={18}/></button></div> : <div className="cs-queue-hero"><h3>{list.loading ? 'Loading assigned work…' : 'No reviews assigned'}</h3><button className="cs-primary" onClick={() => next()} disabled={busy || list.loading}>{busy ? 'Checking queue…' : 'Start next review'}<ArrowRight size={18}/></button></div>}
      <h3>Coming next</h3><div className="cs-table-wrap"><table><thead><tr><th>Customer</th><th>Topic</th><th>Status</th></tr></thead><tbody>{pending.slice(first ? 1 : 0, 5).map(review => { const issue = issueForReview(review); return <tr key={idOf(review)}><td><strong>{issue.customerName || 'Name not recorded'}</strong></td><td>{categoryLabels(issue.categoryIds, categories)}</td><td><span className="cs-badge">{prettyStatus(review.status)}</span></td></tr>; })}</tbody></table></div>{!pending.length && <p className="cs-muted">No more reviews.</p>}</section></div>}
    {!capabilities.review && <section className="cs-card"><p className="cs-eyebrow">Captured chats</p><h2>Conversations</h2><ResourceState loading={issueList.loading} error={issueList.error}/>{(issueList.data?.issues || []).filter(issue => matchesIssue(issue, filters)).map(issue => <div className="cs-toolbar" key={idOf(issue)} style={{ borderBottom: '1px solid #eceef1', padding: '12px 0' }}><div><strong>{issue.customerName || 'Customer'}</strong><p className="cs-muted">{issue.summary || categoryLabels(issue.categoryIds, categories)}</p></div><button onClick={() => setReadOnlyIssue(idOf(issue))}>View conversation</button></div>)}{issueList.data && !issueList.data.issues?.length && <p className="cs-muted">No captured conversations in this scope.</p>}</section>}
    {!active && readOnlyIssue && detail.data && <div style={{ marginTop: 18 }}><Conversation issue={detail.data.issue} messages={detail.data.messages || []}/></div>}
    {context && activeIssue && <CustomerContextDrawer filters={filters} customerId={activeIssue.customerId} customerName={activeIssue.customerName} issues={[activeIssue]} categories={categories} capabilities={capabilities} currentUserId={currentUserId} onClose={() => setContext(false)}/>}
  </>;
}
