import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { waitingDays, dubaiDateKey, exportCollectionRows } from '../../utils/collectionOperations';

const labels = { pending: 'Pending', not_refunded: 'Pending', refunded: 'Done' };
const date = value => value ? new Date(value).toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' }) : 'Not recorded';
export default function CollectionRefundTracker({ search = '', dateFrom = '', dateTo = '', owners = [], resetKey = 0, onUpdated } = {}) {
  const [rows, setRows] = useState([]), [filter, setFilter] = useState('pending'), [page, setPage] = useState(1), [pages, setPages] = useState(0), [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true), [canUpdate, setCanUpdate] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(null), [note, setNote] = useState(''), [reference, setReference] = useState(''), [busy, setBusy] = useState(false);
  const eventId = useRef(''), request = useRef(0), saving = useRef(false);
  const [ownerFilter, setOwnerFilter] = useState(''), [mode, setMode] = useState('refund'), [ownerId, setOwnerId] = useState(''), [dueDate, setDueDate] = useState(''), [exporting, setExporting] = useState(false);
  useEffect(() => { setOwnerFilter(''); setFilter('pending'); setPage(1); setSelected(null); }, [resetKey]);
  const load = useCallback(async () => {
    const current = ++request.current; setLoading(true); setError('');
    try {
      const { data } = await api.get('/collections/refunds', { params: { status: filter, page, search, dateFrom, dateTo, owner: ownerFilter } });
      if (current !== request.current) return;
      setRows(data.data || []); setPages(data.pages || 0); setTotal(data.total || 0); setCanUpdate(data.canUpdate === true);
    } catch (err) { if (current === request.current) setError(err.response?.data?.message || 'Could not load refund tracking.'); }
    finally { if (current === request.current) setLoading(false); }
  }, [filter, page, search, dateFrom, dateTo, ownerFilter]);
  useEffect(() => { setPage(1); setSelected(null); }, [search, dateFrom, dateTo, ownerFilter]);
  useEffect(() => { load(); return () => { request.current++; }; }, [load]);
  useEffect(() => { if (selected) return undefined; const timer = setInterval(load, 30000); return () => clearInterval(timer); }, [load, selected]);
  function choose(row, action = 'refund') {
    setMode(action); setOwnerId(row.collectionRefund?.owner || ''); setDueDate(row.collectionRefund?.dueDate || '');
    setSelected(row); setNote(''); setReference(''); setError(''); setNotice('');
    eventId.current = window.crypto?.randomUUID?.() || `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  async function save(event) {
    event.preventDefault(); if (saving.current) return;
    const followUpDate = event.currentTarget.elements.namedItem('followUpDate')?.value ?? dueDate;
    if (mode === 'refund' && !reference.trim()) { setError('Enter the transaction reference before marking this refund as Done.'); return; }
    if (mode === 'assignment' && !ownerId) { setError('Choose a refund owner.'); return; }
    saving.current = true; setBusy(true); setError('');
    try {
      await api.post(`/collections/${selected._id}/${mode === 'assignment' ? 'refund-assignment' : 'refund'}`, { ...(mode === 'assignment' ? { ownerId, dueDate: followUpDate } : { status: 'refunded', note, reference: reference.trim() }), version: selected.collectionRefund?.version || 0, eventId: eventId.current });
      setSelected(null); setNotice(mode === 'assignment' ? 'Refund owner and follow-up date saved.' : 'Refund marked as Done.'); await load(); onUpdated?.();
    } catch (err) { setError(err.response?.data?.message || 'Could not save the refund update. Refresh and retry.'); }
    finally { saving.current = false; setBusy(false); }
  }
  async function exportRows() {
    setExporting(true); setError('');
    try { await exportCollectionRows(api, { report: 'refunds', status: filter, search, dateFrom, dateTo, owner: ownerFilter }, 'refunds.csv'); }
    catch { setError('Could not export. Try a narrower date range and retry.'); }
    finally { setExporting(false); }
  }
  return <section id="collection-refunds" className="collection-card collection-refunds" aria-label="Refund tracking">
    <div className="collection-register-heading"><h2>Refund tracking <span>{total}</span></h2><button type="button" className="collection-secondary" onClick={load} disabled={loading || busy}>Refresh refunds</button></div>
    <p className="collection-hint">Completed collections with a refund request. AED 155 per customer deposit.</p>
    <div className="collection-refund-filters" aria-label="Refund status filters">{[['pending', 'Pending'], ['refunded', 'Done']].map(([key, label]) => <button key={key} type="button" className="collection-secondary" aria-pressed={filter === key} disabled={busy} onClick={() => { setFilter(key); setPage(1); setSelected(null); }}>{label}</button>)}</div>
    <label htmlFor="collection-refund-owner-filter">Refund owner</label><select id="collection-refund-owner-filter" value={ownerFilter} disabled={busy} onChange={event => setOwnerFilter(event.target.value)}><option value="">All owners</option><option value="unassigned">Unassigned</option>{owners.map(owner => <option key={owner._id} value={owner._id}>{owner.name}</option>)}</select>
    <button type="button" className="collection-secondary collection-export" onClick={exportRows} disabled={busy || loading || exporting}>{exporting ? 'Exporting…' : 'Export matching refunds'}</button>
    <details><summary>How refund tracking works</summary><p className="collection-hint">Pending: collection completed and refund requested. Done: staff recorded a refund with a transaction reference. This page does not verify bank payments. Customer search and scheduled collection date filters above apply here too. Pending requests are listed oldest collection first; missing collection times need review.</p></details>
    {error && <p role="alert" className="collection-error">{error}</p>}{notice && <p role="status" className="collection-notice">{notice}</p>}
    {selected && <form className="collection-refund-editor" onSubmit={save} aria-label="Update refund status">
      <h3>{mode === 'assignment' ? 'Assign refund follow-up' : 'Mark as done'} · {selected.customerName}</h3>
      <fieldset disabled={busy}><legend className="sr-only">Refund update</legend>
        {mode === 'assignment' ? <><label htmlFor="collection-refund-owner">Refund owner</label><select id="collection-refund-owner" value={ownerId} required autoFocus onChange={event => setOwnerId(event.target.value)}><option value="">Choose a manager</option>{owners.map(owner => <option key={owner._id} value={owner._id}>{owner.name}</option>)}</select><label htmlFor="collection-refund-due">Follow-up date · Dubai (optional)</label><input id="collection-refund-due" name="followUpDate" type="date" value={dueDate} onInput={event => setDueDate(event.currentTarget.value)} onChange={event => setDueDate(event.target.value)} /><p className="collection-hint">Choose a staff follow-up date. This is not a promised payment deadline.</p></> : <><label htmlFor="collection-refund-reference">Transaction reference (required)</label><input id="collection-refund-reference" value={reference} autoFocus required maxLength={200} onChange={event => setReference(event.target.value)} />
        <label htmlFor="collection-refund-note">Confirmation notes</label><textarea id="collection-refund-note" required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="Payment confirmation" />
        <p className="collection-hint">Saving records the status only. It does not send money.</p>
        </>}
        <div className="collection-refund-filters"><button className="collection-primary" type="submit">{busy ? 'Saving…' : mode === 'assignment' ? 'Save follow-up' : 'Confirm refund done'}</button><button type="button" className="collection-secondary" onClick={() => setSelected(null)}>Cancel</button></div>
      </fieldset>
    </form>}
    {loading ? <p role="status">Loading refund tracking…</p> : error ? <p>Refresh refunds to reload the current records.</p> : !rows.length ? <p className="collection-empty">No matching {filter === 'pending' ? 'pending' : 'completed'} refund requests. Try clearing the filters. Only completed collections with a refund request appear here.</p> : <ul className="collection-records collection-scroll-records" tabIndex={0} aria-label="Matching refund requests">{rows.map(row => <li key={row._id}>
      <div className="collection-record-title"><strong>{row.customerName}</strong><span className={`collection-status ${row.refundStatus === 'refunded' ? 'is-complete' : ''}`}>{labels[row.refundStatus] || labels.pending}</span></div>
      <p>{row.customerId} · AED 155 · Collected: {date(row.collectionDetails?.collectedAt || row.completedAt)}</p>
      <p>Scheduled collection date: {date(row.scheduledTime)}</p>
      {row.refundStatus !== 'refunded' && <><p>Owner: {row.collectionRefund?.ownerName || 'Unassigned'} · Follow-up: {row.collectionRefund?.dueDate || 'Not set'}</p><p className="collection-next-action"><strong>Next:</strong> {row.collectionRefund?.ownerName ? 'Confirm the payment, then record the transaction reference.' : 'Assign a manager to follow up.'} {waitingDays(row.collectionDetails?.collectedAt || row.completedAt) === null ? 'Collection time missing — review the collection record.' : `${waitingDays(row.collectionDetails?.collectedAt || row.completedAt)} calendar days since collection.`}{row.collectionRefund?.dueDate && row.collectionRefund.dueDate < dubaiDateKey() ? ' Staff follow-up date has passed.' : ''}</p></>}
      {row.recordedForCustomer ? <p>Refund already recorded for this customer against another collection or in Bag Operations.</p> : <>
        {row.collectionRefund?.updatedByName && <p>Updated by {row.collectionRefund.updatedByName} · {date(row.collectionRefund.updatedAt)}</p>}
        {row.collectionRefund?.reference && <p>Transaction reference: {row.collectionRefund.reference}</p>}
        {row.collectionRefund?.note && <p>{row.collectionRefund.note}</p>}
      </>}
      {!!row.collectionRefund?.history?.length && <details><summary>Update history</summary>{row.collectionRefund.history.map(event => <p key={event.eventId}>{labels[event.status]} · {event.actorName} · {date(event.timestamp)}<br />{event.note}{event.reference && ` · ${event.reference}`}</p>)}</details>}
      {!!row.collectionRefund?.assignmentHistory?.length && <details><summary>Follow-up history</summary>{row.collectionRefund.assignmentHistory.map(event => <p key={event.eventId}>{event.ownerName} · Follow-up: {event.dueDate || 'Not set'} · Assigned by {event.actorName} · {date(event.timestamp)}</p>)}</details>}
      {canUpdate && row.refundStatus !== 'refunded' && <div className="collection-refund-filters"><button className="collection-secondary" type="button" disabled={busy || !owners.length} onClick={() => choose(row, 'assignment')}>Assign follow-up</button><button className="collection-secondary" type="button" disabled={busy} onClick={() => choose(row)}>Mark as done</button></div>}
    </li>)}</ul>}
    {!canUpdate && !loading && <p className="collection-hint">An admin or manager can update refund statuses.</p>}
    {pages > 1 && <nav className="collection-pagination" aria-label="Refund pages"><button type="button" disabled={page === 1 || loading || busy} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {page} of {pages}</span><button type="button" disabled={page >= pages || loading || busy} onClick={() => setPage(current => current + 1)}>Next</button></nav>}
  </section>;
}
