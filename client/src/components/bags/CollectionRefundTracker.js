import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';

const labels = { pending: 'Pending', not_refunded: 'Pending', refunded: 'Done' };
const date = value => value ? new Date(value).toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' }) : 'Not recorded';
const demoRequests = [
  { _id: 'demo-pending', customerId: 'DEMO-001', customerName: 'Demo customer · Pending refund', refundStatus: 'pending', completedAt: '2026-11-26T08:00:00+04:00' },
  { _id: 'demo-done', customerId: 'DEMO-002', customerName: 'Demo customer · Completed refund', refundStatus: 'refunded', completedAt: '2026-11-25T08:00:00+04:00', collectionRefund: { updatedByName: 'Demo accounts team', updatedAt: '2026-11-26T10:00:00+04:00', reference: 'DEMO-PAYMENT-002', note: 'Demo only: AED 155 deposit refund confirmed.' } }
];
export default function CollectionRefundTracker() {
  const [demo, setDemo] = useState(false);
  const [rows, setRows] = useState([]), [filter, setFilter] = useState('pending'), [page, setPage] = useState(1), [pages, setPages] = useState(0), [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true), [canUpdate, setCanUpdate] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(null), [note, setNote] = useState(''), [reference, setReference] = useState(''), [busy, setBusy] = useState(false);
  const eventId = useRef(''), request = useRef(0), saving = useRef(false);
  const displayRows = demo ? demoRequests : rows;
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
  useEffect(() => { if (selected || demo) return undefined; const timer = setInterval(load, 30000); return () => clearInterval(timer); }, [load, selected, demo]);
  function choose(row) {
    if (demo) return;
    setSelected(row); setNote(''); setReference(''); setError(''); setNotice('');
    eventId.current = window.crypto?.randomUUID?.() || `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  async function save(event) {
    event.preventDefault(); if (demo || saving.current) return; saving.current = true; setBusy(true); setError('');
    try {
      await api.post(`/collections/${selected._id}/refund`, { status: 'refunded', note, reference, version: selected.collectionRefund?.version || 0, eventId: eventId.current });
      setSelected(null); setNotice('Refund marked as Done.'); await load();
    } catch (err) { setError(err.response?.data?.message || 'Could not save the refund update. Refresh and retry.'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <section className="collection-card collection-refunds" aria-label="Refund tracking">
    <div className="collection-register-heading"><h2>Refund tracking <span>{demo ? '2 demos' : total}</span></h2><button type="button" className="collection-secondary" onClick={load} disabled={loading || busy || demo}>Refresh refunds</button></div>
    <p className="collection-hint">After collection, refund requests appear as Pending. Once the AED 155 deposit is refunded, mark the request as Done.</p>
    <button type="button" className="collection-secondary" aria-pressed={demo} disabled={busy} onClick={() => { setDemo(current => !current); setSelected(null); setNotice(''); }}>{demo ? 'Back to real requests' : 'View demo requests'}</button>
    {demo ? <p role="status" className="collection-notice">Demo only · One Pending and one Done request. These examples are not saved, do not affect totals, and cannot record payments.</p> : <div className="collection-refund-filters" aria-label="Refund status filters">{[['pending', 'Pending'], ['refunded', 'Done']].map(([key, label]) => <button key={key} type="button" className="collection-secondary" aria-pressed={filter === key} disabled={busy} onClick={() => { setFilter(key); setPage(1); setSelected(null); }}>{label}</button>)}</div>}
    {!demo && error && <p role="alert" className="collection-error">{error}</p>}{!demo && notice && <p role="status" className="collection-notice">{notice}</p>}
    {selected && <form className="collection-refund-editor" onSubmit={save} aria-label="Update refund status">
      <h3>Mark refunded · {selected.customerName}</h3>
      <fieldset disabled={busy}><legend className="sr-only">Refund update</legend>
        <label htmlFor="collection-refund-reference">Payment reference (required)</label><input id="collection-refund-reference" value={reference} required maxLength={200} onChange={event => setReference(event.target.value)} />
        <label htmlFor="collection-refund-note">Confirmation notes</label><textarea id="collection-refund-note" required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="Payment confirmation" />
        <p className="collection-hint">Saving records the status only. It does not send money.</p>
        <div className="collection-refund-filters"><button className="collection-primary" type="submit">{busy ? 'Saving…' : 'Confirm refund done'}</button><button type="button" className="collection-secondary" onClick={() => setSelected(null)}>Cancel</button></div>
      </fieldset>
    </form>}
    {!demo && loading ? <p role="status">Loading refund tracking…</p> : !displayRows.length ? <p className="collection-empty">No collections in this refund status.</p> : <ul className="collection-records">{displayRows.map(row => <li key={row._id}>
      <div className="collection-record-title"><strong>{row.customerName}</strong><span className={`collection-status ${row.refundStatus === 'refunded' ? 'is-complete' : ''}`}>{labels[row.refundStatus] || labels.pending}</span></div>
      <p>{row.customerId} · AED 155 · Collected: {date(row.collectionDetails?.collectedAt || row.completedAt)}</p>
      {row.recordedForCustomer ? <p>Refund already recorded for this customer against another collection or in Bag Operations.</p> : <>
        {row.collectionRefund?.updatedByName && <p>Updated by {row.collectionRefund.updatedByName} · {date(row.collectionRefund.updatedAt)}</p>}
        {row.collectionRefund?.reference && <p>Reference: {row.collectionRefund.reference}</p>}
        {row.collectionRefund?.note && <p>{row.collectionRefund.note}</p>}
      </>}
      {!!row.collectionRefund?.history?.length && <details><summary>Update history</summary>{row.collectionRefund.history.map(event => <p key={event.eventId}>{labels[event.status]} · {event.actorName} · {date(event.timestamp)}<br />{event.note}{event.reference && ` · ${event.reference}`}</p>)}</details>}
      {(demo || canUpdate) && row.refundStatus !== 'refunded' && <button className="collection-secondary" type="button" disabled={busy || demo} onClick={() => choose(row)}>Mark refunded</button>}
    </li>)}</ul>}
    {!demo && !canUpdate && !loading && <p className="collection-hint">An admin or manager can update refund statuses.</p>}
    {!demo && pages > 1 && <nav className="collection-pagination" aria-label="Refund pages"><button type="button" disabled={page === 1 || loading || busy} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {page} of {pages}</span><button type="button" disabled={page >= pages || loading || busy} onClick={() => setPage(current => current + 1)}>Next</button></nav>}
  </section>;
}
