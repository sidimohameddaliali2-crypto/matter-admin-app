import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';

const labels = { pending: 'Pending refund', not_refunded: 'Not refunded', refunded: 'Refunded' };
const date = value => value ? new Date(value).toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' }) : 'Not recorded';
export default function CollectionRefundTracker() {
  const [rows, setRows] = useState([]), [filter, setFilter] = useState('pending'), [page, setPage] = useState(1), [pages, setPages] = useState(0), [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true), [canUpdate, setCanUpdate] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(null), [status, setStatus] = useState('not_refunded'), [note, setNote] = useState(''), [reference, setReference] = useState(''), [busy, setBusy] = useState(false);
  const eventId = useRef(''), request = useRef(0), saving = useRef(false);
  const load = useCallback(async () => {
    const current = ++request.current; setLoading(true); setError('');
    try {
      const { data } = await api.get('/collections/refunds', { params: { status: filter, page } });
      if (current !== request.current) return;
      setRows(data.data || []); setPages(data.pages || 0); setTotal(data.total || 0); setCanUpdate(data.canUpdate === true);
    } catch (err) { if (current === request.current) setError(err.response?.data?.message || 'Could not load refund tracking.'); }
    finally { if (current === request.current) setLoading(false); }
  }, [filter, page]);
  useEffect(() => { load(); return () => { request.current++; }; }, [load]);
  useEffect(() => { if (selected) return undefined; const timer = setInterval(load, 30000); return () => clearInterval(timer); }, [load, selected]);
  function choose(row) {
    setSelected(row); setStatus('not_refunded'); setNote(''); setReference(''); setError(''); setNotice('');
    eventId.current = window.crypto?.randomUUID?.() || `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  async function save(event) {
    event.preventDefault(); if (saving.current) return; saving.current = true; setBusy(true); setError('');
    try {
      await api.post(`/collections/${selected._id}/refund`, { status, note, reference, version: selected.collectionRefund?.version || 0, eventId: eventId.current });
      setSelected(null); setNotice(status === 'refunded' ? 'Refund recorded as completed.' : 'Recorded as not refunded. It remains outstanding.'); await load();
    } catch (err) { setError(err.response?.data?.message || 'Could not save the refund update. Refresh and retry.'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <section className="collection-card collection-refunds" aria-label="Refund tracking">
    <div className="collection-register-heading"><h2>Refund tracking <span>{total}</span></h2><button type="button" className="collection-secondary" onClick={load} disabled={loading || busy}>Refresh refunds</button></div>
    <p className="collection-hint">Completed collections marked for a refund appear here as Pending refund. AED 155 per customer deposit. Record payments made outside the app.</p>
    <div className="collection-refund-filters" aria-label="Refund status filters">{[['pending', 'Pending refund'], ['not_refunded', 'Not refunded'], ['refunded', 'Refunded'], ['all', 'All']].map(([key, label]) => <button key={key} type="button" className="collection-secondary" aria-pressed={filter === key} disabled={busy} onClick={() => { setFilter(key); setPage(1); setSelected(null); }}>{label}</button>)}</div>
    {error && <p role="alert" className="collection-error">{error}</p>}{notice && <p role="status" className="collection-notice">{notice}</p>}
    {selected && <form className="collection-refund-editor" onSubmit={save} aria-label="Update refund status">
      <h3>Update refund · {selected.customerName}</h3>
      <fieldset disabled={busy}><legend className="sr-only">Refund update</legend>
        <label htmlFor="collection-refund-status">Refund status</label><select id="collection-refund-status" value={status} onChange={event => setStatus(event.target.value)}><option value="not_refunded">Not refunded</option><option value="refunded">Refunded</option></select>
        <label htmlFor="collection-refund-reference">Payment reference {status === 'refunded' ? '(required)' : '(optional)'}</label><input id="collection-refund-reference" value={reference} required={status === 'refunded'} maxLength={200} onChange={event => setReference(event.target.value)} />
        <label htmlFor="collection-refund-note">Update notes</label><textarea id="collection-refund-note" required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="Payment confirmation or why the refund is still outstanding" />
        <p className="collection-hint">Saving records the status only. It does not send money.</p>
        <div className="collection-refund-filters"><button className="collection-primary" type="submit">{busy ? 'Saving…' : 'Save refund update'}</button><button type="button" className="collection-secondary" onClick={() => setSelected(null)}>Cancel</button></div>
      </fieldset>
    </form>}
    {loading ? <p role="status">Loading refund tracking…</p> : !rows.length ? <p className="collection-empty">No collections in this refund status.</p> : <ul className="collection-records">{rows.map(row => <li key={row._id}>
      <div className="collection-record-title"><strong>{row.customerName}</strong><span className={`collection-status ${row.refundStatus === 'refunded' ? 'is-complete' : ''}`}>{labels[row.refundStatus] || labels.pending}</span></div>
      <p>{row.customerId} · AED 155 · Collected: {date(row.collectionDetails?.collectedAt || row.completedAt)}</p>
      {row.recordedForCustomer ? <p>Refund already recorded for this customer against another collection or in Bag Operations.</p> : <>
        {row.collectionRefund?.updatedByName && <p>Updated by {row.collectionRefund.updatedByName} · {date(row.collectionRefund.updatedAt)}</p>}
        {row.collectionRefund?.reference && <p>Reference: {row.collectionRefund.reference}</p>}
        {row.collectionRefund?.note && <p>{row.collectionRefund.note}</p>}
      </>}
      {!!row.collectionRefund?.history?.length && <details><summary>Update history</summary>{row.collectionRefund.history.map(event => <p key={event.eventId}>{labels[event.status]} · {event.actorName} · {date(event.timestamp)}<br />{event.note}{event.reference && ` · ${event.reference}`}</p>)}</details>}
      {canUpdate && row.refundStatus !== 'refunded' && <button className="collection-secondary" type="button" disabled={busy} onClick={() => choose(row)}>Update refund</button>}
    </li>)}</ul>}
    {!canUpdate && !loading && <p className="collection-hint">An admin or manager can update refund statuses.</p>}
    {pages > 1 && <nav className="collection-pagination" aria-label="Refund pages"><button type="button" disabled={page === 1 || loading || busy} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {page} of {pages}</span><button type="button" disabled={page >= pages || loading || busy} onClick={() => setPage(current => current + 1)}>Next</button></nav>}
  </section>;
}
