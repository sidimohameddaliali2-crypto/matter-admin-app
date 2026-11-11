import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Save } from 'lucide-react';
import api from '../../utils/api';
import OwnerSelector from './OwnerSelector';
import { errorMessage, formatDubai, fromDubaiInput, idOf, isStaffReply, newRequestId, prettyStatus, servicePath, toDubaiInput, unpack } from './serviceUtils';

const draftFor = (review, issue) => ({ summary: review.draft?.summary ?? issue?.summary ?? '', categoryIds: review.draft?.categoryIds || issue?.categoryIds || [], verdict: review.draft?.verdict || '', outcome: review.draft?.outcome || issue?.outcome || 'unknown', note: review.draft?.note || '', evidenceMessageIds: review.draft?.evidenceMessageIds || [], confirmIssueBoundary: review.draft?.confirmIssueBoundary || false, action: review.draft?.action || null });

export default function ReviewPanel({ review, detail, categories = [], owners = [], capabilities = {}, currentUserId, onSubmitted, onReviewChanged, onSkipped, onReload }) {
  const [form, setForm] = useState(() => draftFor(review, detail?.issue));
  const [due, setDue] = useState(() => toDubaiInput(review.draft?.action?.dueAt));
  const [version, setVersion] = useState(review.version);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [skipReason, setSkipReason] = useState('');
  const [showSkip, setShowSkip] = useState(false);
  const lock = useRef(false);
  const request = useRef(null);
  const skipRequest = useRef(null);
  const issue = detail?.issue || {};
  useEffect(() => { setVersion(review.version); }, [review.version]);
  const stale = Boolean(review.stale || (issue.sourceRevision != null && review.sourceRevision !== issue.sourceRevision));
  const leaseExpired = Boolean(review.leaseUntil && new Date(review.leaseUntil).getTime() <= Date.now());
  const provisional = form.outcome !== 'resolved';
  const submitted = review.status === 'submitted';
  const unmapped = Boolean(issue.sourceMetadata?.unmappedStaff || (Array.isArray(issue.contributorIds) && !issue.contributorIds.length));
  const boundaryRequired = issue.boundaryState === 'needs_review';
  const openActions = (detail?.actions || []).some(action => action.status !== 'completed');
  const internalIds = new Set((detail?.messages || []).filter(message => message.internalNote === true).map(idOf));
  const internalEvidence = form.evidenceMessageIds.some(id => internalIds.has(id));
  const invalidPromise = Boolean(form.action?.promisedDueAt && !isStaffReply((detail?.messages || []).find(message => idOf(message) === form.action?.promiseMessageId)));
  const invalid = internalEvidence || invalidPromise || !form.summary.trim() || !form.verdict || (form.verdict === 'needs_work' && !form.note.trim()) || (form.verdict !== 'insufficient' && (unmapped || !form.evidenceMessageIds.length || (boundaryRequired && !form.confirmIssueBoundary))) || (form.outcome === 'resolved' && (form.verdict === 'insufficient' || !form.note.trim() || !form.evidenceMessageIds.length || form.action || openActions)) || (form.action && (!form.action.description?.trim() || !due || (form.action.promisedDueAt && !form.action.promiseMessageId)));
  const update = (key, value) => { setForm(previous => ({ ...previous, [key]: value })); setNotice(''); };
  const updateAction = (key, value) => setForm(previous => ({ ...previous, action: { ...previous.action, [key]: value } }));
  const payload = () => ({ ...form, summary: form.summary.trim(), note: form.note.trim(), action: form.action ? { ...form.action, description: form.action.description.trim(), ownerId: form.action.ownerId || null, dueAt: fromDubaiInput(due) } : undefined });
  async function saveDraft() {
    if (lock.current) return; lock.current = true; setBusy('draft'); setError(''); setNotice('');
    try {
      const saved = unpack(await api.put(`${servicePath}/reviews/${encodeURIComponent(idOf(review))}/draft`, { version, draft: payload() }));
      const nextReview = saved?.review;
      if (nextReview?.version != null) setVersion(nextReview.version);
      onReviewChanged?.(nextReview); setNotice('Draft saved. You can return to this review.'); request.current = null;
    } catch (failure) { setError(errorMessage(failure, 'Draft could not be saved. Your edits remain here.')); }
    finally { lock.current = false; setBusy(''); }
  }
  async function submit(event) {
    event.preventDefault(); if (lock.current || invalid || stale || leaseExpired || submitted) return;
    lock.current = true; setBusy('submit'); setError(''); setNotice('');
    const command = { ...payload(), version, sourceRevision: review.sourceRevision };
    const signature = JSON.stringify(command);
    if (request.current?.signature !== signature) request.current = { signature, id: newRequestId() };
    try {
      const saved = unpack(await api.post(`${servicePath}/reviews/${encodeURIComponent(idOf(review))}/submit`, { ...command, requestId: request.current.id }));
      await onSubmitted?.(saved); request.current = null;
    } catch (failure) { setError(errorMessage(failure, 'Review could not be saved. You have not moved to the next case.')); }
    finally { lock.current = false; setBusy(''); }
  }
  async function skip() {
    if (lock.current || !skipReason.trim()) return;
    lock.current = true; setBusy('skip'); setError('');
    const signature = `${version}:${skipReason.trim()}`;
    if (skipRequest.current?.signature !== signature) skipRequest.current = { signature, id: newRequestId() };
    try {
      const saved = unpack(await api.post(`${servicePath}/reviews/${encodeURIComponent(idOf(review))}/skip`, { version, reason: skipReason.trim(), requestId: skipRequest.current.id }));
      await onSkipped?.(saved); skipRequest.current = null;
    } catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setBusy(''); }
  }
  return <section className="cs-card cs-review-panel" aria-label="Review this issue"><h2>Review this issue</h2><div className="cs-reviewer-line">Reviewer: you · Source responders are shown beside their messages.<br/>Review {prettyStatus(review.status)}{review.leaseUntil ? ` · Claim until ${formatDubai(review.leaseUntil)}` : ''}</div>
    {internalEvidence && <div className="cs-notice">Internal notes cannot support a handling grade. <button type="button" onClick={() => update('evidenceMessageIds',form.evidenceMessageIds.filter(id => !internalIds.has(id)))}>Remove internal notes</button></div>}
    {invalidPromise && <p className="cs-notice">Choose a customer-facing promise message.</p>}
    {error && <div className="cs-alert" role="alert">{error} Your edits remain on this case.</div>}{notice && <div className="cs-success" role="status">{notice}</div>}{stale && <div className="cs-notice">New evidence. Reload before submitting.{onReload && <button className="cs-link-button" onClick={onReload} type="button">Reload current review</button>}</div>}{leaseExpired && <div className="cs-notice">Claim expired. Renew to keep reviewing.{onReload && <button type="button" onClick={onReload}>Renew review claim</button>}</div>}
    <form onSubmit={submit} className="cs-form-stack"><label>Summary (draft)<textarea aria-label="Review summary" value={form.summary} maxLength={4000} onChange={event => update('summary', event.target.value)} disabled={Boolean(busy) || submitted} required /></label>
      <fieldset><legend>Issue category</legend><div className="cs-chip-row">{categories.map(category => <label key={category.id} className="cs-checkbox"><input type="checkbox" checked={form.categoryIds.includes(category.id)} onChange={event => update('categoryIds', event.target.checked ? [...form.categoryIds, category.id] : form.categoryIds.filter(id => id !== category.id))} disabled={Boolean(busy) || submitted} />{category.label}</label>)}</div>{!categories.length && <p className="cs-muted">Category definitions are unavailable. Reload before submitting.</p>}</fieldset>
      <label>Issue outcome<select aria-label="Issue outcome" value={form.outcome} onChange={event => update('outcome', event.target.value)} disabled={Boolean(busy) || submitted}><option value="open">Open / follow-up pending</option><option value="resolved">Resolved with evidence</option><option value="unknown">Not established</option></select></label>
      {unmapped && <div className="cs-notice">Staff identity unverified. Choose Not enough information.</div>}
      <fieldset><legend>How was this handled?</legend>{[['good', 'Good'], ['needs_work', 'Needs work'], ['insufficient', 'Not enough information']].map(([value, label]) => <label className="cs-radio" key={value}><input type="radio" name={`verdict-${idOf(review)}`} value={value} checked={form.verdict === value} onChange={() => update('verdict', value)} disabled={Boolean(busy) || submitted || (unmapped && value !== 'insufficient')} />{label}</label>)}<p className="cs-muted">{provisional ? 'Rating provisional · outcome open.' : 'Resolution needs evidence.'}</p></fieldset>
      <label>{form.verdict === 'needs_work' ? 'Reason (required)' : 'Review note'}<textarea aria-label="Review note" value={form.note} maxLength={4000} onChange={event => update('note', event.target.value)} disabled={Boolean(busy) || submitted} placeholder="Understanding, correct action, next step and respectful communication" /></label>
      {form.outcome === 'resolved' && (openActions || form.action) && <div className="cs-notice">Open follow-ups prevent confirmed issue resolution. Keep the outcome open until their actual effects are verified.</div>}
      <details open={form.verdict === 'needs_work' || boundaryRequired}><summary>Supporting message references ({form.evidenceMessageIds.length})</summary><p className="cs-muted" style={{ marginTop: 8 }}>Select supporting messages.</p><div className="cs-evidence">{(detail?.messages || []).filter(message => message.internalNote !== true).map(message => <label key={idOf(message)} className="cs-checkbox"><input type="checkbox" checked={form.evidenceMessageIds.includes(idOf(message))} disabled={Boolean(busy) || submitted} onChange={event => update('evidenceMessageIds', event.target.checked ? [...form.evidenceMessageIds, idOf(message)] : form.evidenceMessageIds.filter(id => id !== idOf(message)))} /><span><strong>{message.authorName || 'Unknown author'}</strong>: {message.text?.slice(0, 160) || `${message.type || 'Message'} · evidence unavailable`}</span></label>)}{!detail?.messages?.length && <p className="cs-muted">No captured message references.</p>}</div></details>
      {boundaryRequired && <label className="cs-checkbox"><input type="checkbox" checked={form.confirmIssueBoundary} onChange={event => update('confirmIssueBoundary', event.target.checked)} disabled={Boolean(busy) || submitted} /><span>The selected messages define this issue episode. I checked surrounding context for other issues.</span></label>}
      <div><h3>Next action</h3>{review.sampleType === 'calibration' ? <p className="cs-muted">Calibration is independent. Record any operational follow-up through the Problems queue.</p> : <label className="cs-checkbox"><input type="checkbox" checked={Boolean(form.action)} disabled={Boolean(busy) || submitted} onChange={event => update('action', event.target.checked ? { description: '', ownerId: capabilities.assignRequests ? currentUserId : null } : null)} />Follow-up needed</label>}</div>
      {form.action && <div className="cs-form-stack"><label>Action<textarea aria-label="Follow-up action" value={form.action.description || ''} maxLength={2000} onChange={event => updateAction('description', event.target.value)} disabled={Boolean(busy) || submitted} required /></label><OwnerSelector value={form.action.ownerId} onChange={value => updateAction('ownerId', value)} owners={owners} capabilities={capabilities} currentUserId={currentUserId} disabled={Boolean(busy) || submitted} /><label>Due · Dubai time<input type="datetime-local" aria-label="Action due in Dubai" value={due} onChange={event => { setDue(event.target.value); setNotice(''); }} disabled={Boolean(busy) || submitted} required /></label><p className="cs-muted"></p><details><summary>Record an explicit customer promise (optional)</summary><label style={{ marginTop: 10 }}>Promised due · Dubai time<input type="datetime-local" aria-label="Customer promised due in Dubai" value={toDubaiInput(form.action.promisedDueAt)} onChange={event => updateAction('promisedDueAt', fromDubaiInput(event.target.value))} disabled={Boolean(busy) || submitted}/></label><label style={{ marginTop: 10 }}>Message containing the promise<select aria-label="Customer promise message" value={form.action.promiseMessageId || ''} onChange={event => updateAction('promiseMessageId', event.target.value || null)} disabled={Boolean(busy) || submitted}><option value="">Choose recorded evidence</option>{(detail?.messages || []).filter(isStaffReply).map(message => <option key={idOf(message)} value={idOf(message)}>{message.authorName || 'Recorded staff author'}: {message.text?.slice(0, 100) || message.type}</option>)}</select></label><p className="cs-muted" style={{ marginTop: 8 }}>Only record a time explicitly promised in the selected message. The original promise remains visible if an internal due time changes.</p></details></div>}
      <div className="cs-form-actions"><button type="button" onClick={saveDraft} disabled={capabilities.previewReadOnly || Boolean(busy) || submitted}><Save size={14}/>{busy === 'draft' ? 'Saving draft…' : 'Save draft'}</button><button className="cs-primary" type="submit" disabled={capabilities.previewReadOnly || Boolean(busy) || invalid || stale || leaseExpired || submitted || !categories.length}>{busy === 'submit' ? 'Saving review…' : 'Save review & next'}<ArrowRight size={16}/></button></div><p className="cs-muted"></p>
    </form>
    {onSkipped && <details open={showSkip} style={{ marginTop: 15 }} onToggle={event => setShowSkip(event.currentTarget.open)}><summary>Skip with a reason</summary><label style={{ marginTop: 10 }}>Why this cannot be reviewed<textarea aria-label="Skip reason" value={skipReason} maxLength={2000} onChange={event => setSkipReason(event.target.value)} /></label><p className="cs-muted"></p><button type="button" onClick={skip} disabled={Boolean(busy) || !skipReason.trim()}>{busy === 'skip' ? 'Saving reason…' : 'Skip review'}</button></details>}
    <details style={{ marginTop: 15 }}><summary>Review history</summary><ol className="cs-history">{(detail?.reviews || []).filter(item => idOf(item) === idOf(review)).flatMap(item => (item.revisions || item.submissions || []).map((revision, index) => <li key={`${idOf(item)}-${index}`}>{formatDubai(revision.submittedAt || revision.at)} · {prettyStatus(revision.verdict)} · {revision.note || revision.summary || 'Saved review revision'}</li>))}{!(detail?.reviews || []).some(item => idOf(item) === idOf(review) && (item.revisions || item.submissions || []).length) && <li>No submitted revision is available for your current review. Other judgments remain hidden during independent review.</li>}</ol></details>
  </section>;
}
