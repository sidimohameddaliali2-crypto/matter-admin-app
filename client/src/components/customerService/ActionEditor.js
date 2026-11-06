import React, { useRef, useState } from 'react';
import api from '../../utils/api';
import OwnerSelector from './OwnerSelector';
import { errorMessage, formatDubai, fromDubaiInput, idOf, newRequestId, prettyStatus, servicePath, toDubaiInput, unpack } from './serviceUtils';

export default function ActionEditor({ action, owners, capabilities, currentUserId, onSaved, onClose }) {
  const [status, setStatus] = useState(action.status);
  const [ownerId, setOwnerId] = useState(idOf(action.ownerId));
  const [due, setDue] = useState(toDubaiInput(action.dueAt));
  const [nextCheck, setNextCheck] = useState(toDubaiInput(action.nextCheckAt));
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const request = useRef(null);
  const reassigned = idOf(action.ownerId) !== ownerId;
  const canEdit = capabilities.supervise || (capabilities.workActions && idOf(action.ownerId) === String(currentUserId));
  const reopened = action.status === 'completed' && status !== 'completed';
  const invalid = !canEdit || (!ownerId && status !== 'unassigned') || (ownerId && status === 'unassigned') || (status === 'waiting' && (!reason.trim() || !nextCheck)) || ((reassigned || reopened) && !reason.trim()) || (status === 'completed' && (!confirmed || !note.trim()));
  async function save(event) {
    event.preventDefault(); if (lock.current || invalid) return;
    lock.current = true; setBusy(true); setError('');
    const payload = { version: action.version, status, reason: reason.trim(), note: note.trim(), ...(capabilities.supervise ? { ownerId: ownerId || null } : {}), ...(due ? { dueAt: fromDubaiInput(due) } : {}), ...(status === 'waiting' ? { nextCheckAt: fromDubaiInput(nextCheck) } : {}), ...(status === 'completed' ? { evidence: { note: note.trim(), confirmedEffect: confirmed, messageIds: [] } } : {}) };
    const signature = JSON.stringify(payload);
    if (request.current?.signature !== signature) request.current = { signature, id: newRequestId() };
    try { const saved = unpack(await api.patch(`${servicePath}/actions/${encodeURIComponent(idOf(action))}`, { ...payload, requestId: request.current.id })); onSaved(saved?.action); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="cs-card" aria-label="Manage customer follow-up"><div className="cs-toolbar"><div><p className="cs-eyebrow">Internal follow-up</p><h2>{action.customerName || 'Customer action'}</h2></div><button onClick={onClose}>Close</button></div><p>{action.description}</p><p className="cs-muted">Action owner, source responder and reviewer may be different people.</p>{error && <div className="cs-alert" role="alert">{error} Your edits remain here.</div>}
    {canEdit ? <form onSubmit={save} className="cs-form-stack"><label>Status<select aria-label="Action status" value={status} onChange={event => setStatus(event.target.value)} disabled={busy}>{['unassigned', 'assigned', 'in_progress', 'waiting', 'completed'].map(value => <option value={value} key={value} disabled={value === 'unassigned' ? Boolean(ownerId) : !ownerId}>{prettyStatus(value)}</option>)}</select></label>{capabilities.supervise ? <OwnerSelector value={ownerId} onChange={value => { setOwnerId(value); if (!value) setStatus('unassigned'); else if (status === 'unassigned') setStatus('assigned'); }} owners={owners} capabilities={capabilities} currentUserId={currentUserId} disabled={busy}/> : <p className="cs-muted">Owned by you. Ask a supervisor to change ownership.</p>}
      <label>Due · Dubai time<input aria-label="Action due in Dubai" type="datetime-local" value={due} onChange={event => setDue(event.target.value)} disabled={busy}/></label>{action.promisedDueAt && <div className="cs-notice">Original customer promise: {formatDubai(action.promisedDueAt)}. Changing an internal check does not cancel that promise.</div>}
      <label>{status === 'waiting' ? 'Waiting reason (required)' : reassigned ? 'Assignment reason (required)' : reopened ? 'Reopen reason (required)' : 'Reason / context'}<textarea value={reason} aria-label="Action update reason" maxLength={2000} onChange={event => setReason(event.target.value)} disabled={busy}/></label>{status === 'waiting' && <label>Next check · Dubai time<input aria-label="Next check in Dubai" type="datetime-local" required value={nextCheck} onChange={event => setNextCheck(event.target.value)} disabled={busy}/></label>}
      <label>{status === 'completed' ? 'Actual result and evidence (required)' : 'Progress note'}<textarea aria-label="Action result and evidence" maxLength={4000} value={note} onChange={event => setNote(event.target.value)} disabled={busy} placeholder={status === 'completed' ? 'What changed, how it was verified and the supporting reference' : 'Record the actual step taken'} /></label>{status === 'completed' && <label className="cs-checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy}/>I verified the actual requested effect; a sent reply alone is not completion.</label>}<button className="cs-primary" type="submit" disabled={busy || invalid}>{busy ? 'Saving…' : 'Save action update'}</button></form> : <div className="cs-notice">This action is read-only in your service scope. Its owner or a supervisor can update it.</div>}
    <details style={{ marginTop: 18 }} open><summary>Action history</summary><ol className="cs-history">{(action.history || []).map((event, index) => <li key={index}><strong>{prettyStatus(event.event || event.status)}</strong> · {formatDubai(event.at)}<br/>{event.reason || event.note || 'Saved action event'}{event.actorId && <><br/>Recorded actor: {idOf(event.actorId)}</>}</li>)}{!action.history?.length && <li>No historical events supplied.</li>}</ol></details>
  </section>;
}
