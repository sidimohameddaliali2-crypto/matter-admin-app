import React, { useRef, useState } from 'react';
import api from '../../utils/api';
import { errorMessage, formatDubai, idOf, newRequestId, prettyStatus, servicePath, useServiceResource } from './serviceUtils';

function ReviewControl({ review, capabilities, owners, onChanged }) {
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false), request = useRef(null);
  const submitted = ['submitted', 'awaiting_evidence'].includes(review.status);
  async function command(kind) {
    if (lock.current) return;
    lock.current = true; setBusy(kind); setError(''); setNotice('');
    const payload = kind === 'calibration' ? { ownerId: owner } : kind === 'reassign' ? { ownerId: owner, reason: reason.trim(), version: review.version } : { reason: reason.trim(), version: review.version };
    const signature = JSON.stringify([kind, payload]);
    if (request.current?.signature !== signature) request.current = { signature, id: newRequestId() };
    try {
      await api.post(`${servicePath}/reviews/${encodeURIComponent(idOf(review))}/${kind}`, { ...payload, requestId: request.current.id });
      request.current = null; setNotice(kind === 'corrections' ? 'Correction request recorded. The original review is retained.' : kind === 'calibration' ? 'Independent calibration review created. Original revisions are retained.' : 'Review reassigned with the reason and original ownership retained.');
      setReason(''); onChanged();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setBusy(''); }
  }
  return <div className="cs-form-stack" style={{ padding: '12px 0' }}>{error && <div className="cs-alert" role="alert">{error}</div>}{notice && <div className="cs-success" role="status">{notice}</div>}
    {(submitted || capabilities.supervise) && <label>{submitted ? 'Correction / oversight reason' : 'Reassignment reason'}<textarea aria-label="Review oversight reason" value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} /></label>}
    {submitted && <button onClick={() => command('corrections')} disabled={Boolean(busy) || !reason.trim()}>{busy === 'corrections' ? 'Saving request…' : 'Request review correction'}</button>}
    {capabilities.supervise && <><label>{submitted ? 'Independent reviewer' : 'New reviewer'}<select aria-label="Review oversight owner" value={owner} onChange={event => setOwner(event.target.value)}><option value="">Select an eligible reviewer</option>{owners.filter(item => idOf(item.userId || item) !== idOf(review.reviewerId) && item.availableMinutes > 0).map(item => <option key={idOf(item.userId || item)} value={idOf(item.userId || item)}>{item.displayName} · {item.availableMinutes} planned min</option>)}</select></label>{submitted ? <button onClick={() => command('calibration')} disabled={Boolean(busy) || !owner}>{busy === 'calibration' ? 'Creating…' : 'Create independent calibration'}</button> : <button onClick={() => command('reassign')} disabled={Boolean(busy) || !owner || !reason.trim()}>{busy === 'reassign' ? 'Reassigning…' : 'Reassign review with reason'}</button>}</>}
  </div>;
}

export default function ReviewHistory({ reviews = [], capabilities = {}, currentUserId, onChanged }) {
  const ownerList = useServiceResource(capabilities.supervise ? '/owners' : null);
  const independentActive = reviews.find(review => review.sampleType === 'calibration' && idOf(review.reviewerId) === String(currentUserId) && !['submitted', 'awaiting_evidence'].includes(review.status));
  const visible = independentActive ? reviews.filter(review => idOf(review) === idOf(independentActive)) : reviews;
  return <section className="cs-card"><h3>Reviews and correction history</h3><p className="cs-muted">Submitted revisions remain historical. Corrections and independent calibration do not erase the original judgment.</p>{independentActive && <div className="cs-notice">Other judgments are hidden while your independent calibration is unfinished.</div>}{ownerList.error && <div className="cs-alert" role="alert">{ownerList.error}</div>}{visible.map(review => <details key={idOf(review)} style={{ marginBottom: 12 }}><summary>{prettyStatus(review.status)} · {prettyStatus(review.sampleType)} · {review.revisions?.length || 0} submitted revisions</summary><ol className="cs-history">{(review.revisions || []).map((revision, index) => <li key={index}><strong>{prettyStatus(revision.verdict)}</strong> · {formatDubai(revision.at)}{revision.provisional && ' · provisional'}<br/>{revision.summary}<br/>{revision.note}</li>)}</ol>{review.stale && <div className="cs-notice">New evidence requires another look. Earlier saved judgments are retained.</div>}{(review.correctionRequests || []).map((request, index) => <p className="cs-muted" key={index}>Correction {request.status || 'open'} · {formatDubai(request.at)} · {request.reason}{request.resolution ? ` · ${request.resolution}` : ''}</p>)}{(capabilities.supervise || idOf(review.reviewerId) === String(currentUserId)) && <ReviewControl review={review} capabilities={capabilities} owners={ownerList.data?.owners || []} onChanged={onChanged}/>}</details>)}{!visible.length && <p className="cs-muted">No reviews are available in your scope.</p>}</section>;
}
