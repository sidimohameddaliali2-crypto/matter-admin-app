import React, { useCallback, useEffect, useRef, useState } from 'react';
import './CollectionRefundComplete.css';
const date = value => value ? new Date(value).toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' }) : 'Not recorded';
const apiBase = () => process.env.REACT_APP_API_URL || (['localhost', '127.0.0.1'].includes(window.location.hostname) ? 'http://localhost:5000/api' : `${window.location.origin}/api`);
export default function CollectionRefundComplete() {
  const [token] = useState(() => window.location.hash.slice(1));
  // Demo mode has no token, makes no API calls and only changes component state.
  const [demo] = useState(() => !window.location.hash.slice(1) && new URLSearchParams(window.location.search).get('demo') === '1');
  const [record, setRecord] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [reference, setReference] = useState(''), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const saving = useRef(false), eventId = useRef(window.crypto?.randomUUID?.() || `accounts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const readVersion = useRef(0);
  const request = useCallback(async (action, body = {}) => {
    const response = await fetch(`${apiBase()}/collection-refund-links/${action}`, { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token }) });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Could not load this refund. Please retry.');
    return data;
  }, [token]);
  const load = useCallback(async () => {
    const current = ++readVersion.current;
    setLoading(true); setError('');
    if (demo) { setRecord({ customerName: 'EXAMPLE CUSTOMER — Demo only', customerId: 'DEMO-ONLY', amount: 155, status: 'pending', collectedAt: new Date().toISOString() }); setLoading(false); return; }
    if (!token) { setError('Open the private refund link from the Accounts email.'); setLoading(false); return; }
    try { const data = await request('view'); if (current === readVersion.current) setRecord(data.data); }
    catch (err) { if (current === readVersion.current) { setError(err.message); setRecord(null); } }
    finally { if (current === readVersion.current) setLoading(false); }
  }, [token, request, demo]);
  useEffect(() => { load(); return () => { readVersion.current++; }; }, [load]);
  async function submit(event) {
    event.preventDefault(); if (saving.current) return;
    if (!reference.trim()) { setError('Enter the transaction reference.'); return; }
    if (!confirmed) { setError('Confirm that the deposit has been refunded.'); return; }
    if (demo) { setRecord(previous => ({ ...previous, status: 'done', reference: reference.trim(), completedAt: new Date().toISOString() })); return; }
    saving.current = true; setBusy(true); setError('');
    try { await request('complete', { reference: reference.trim(), note, confirmed, version: record.version, eventId: eventId.current }); await load(); }
    catch (err) { setError(err.message); }
    finally { saving.current = false; setBusy(false); }
  }
  return <main className="refund-link-page"><section className="refund-link-card">
    <div className="refund-link-brand">MATTER</div><p className="refund-link-eyebrow">ACCOUNTS · BAG DEPOSIT</p>
    <h1>{record?.status === 'done' ? 'Refund recorded as Done' : 'Complete this refund'}</h1>
    {demo && <p role="status" className="refund-link-receipt"><strong>DEMO ONLY — No payment or real refund will change.</strong><br />Use any example transaction reference. Changes are only shown in this page and disappear when you reset or reopen it.</p>}
    {loading ? <p role="status">Loading refund details…</p> : <>
      {record && <><div className={`refund-link-status ${record.status === 'done' ? 'is-done' : ''}`}>{record.status === 'done' ? 'Done' : 'Pending refund'}</div><h2>{record.customerName}</h2><dl><div><dt>Customer ID</dt><dd>{record.customerId}</dd></div><div><dt>Bag deposit</dt><dd>AED {record.amount}</dd></div><div><dt>Collected · Dubai</dt><dd>{date(record.collectedAt)}</dd></div></dl></>}
      {record?.status === 'pending' && <><p>After making the refund, enter its transaction reference to update the team’s tracker.</p><form onSubmit={submit}><fieldset disabled={busy}><legend className="sr-only">Refund confirmation</legend><label htmlFor="accounts-refund-reference">Transaction reference (required)</label><input id="accounts-refund-reference" required autoComplete="off" maxLength={200} value={reference} onChange={event => setReference(event.target.value)} autoFocus /><label htmlFor="accounts-refund-note">Notes (optional)</label><textarea id="accounts-refund-note" maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /><label className="refund-link-check"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm the AED 155 bag deposit has been refunded.</label><p className="refund-link-help">This updates the refund record only. It does not send money.</p><button type="submit">{busy ? 'Saving…' : 'Mark refund as Done'}</button></fieldset></form></>}
      {record?.status === 'done' && <div role="status" className="refund-link-receipt">{record.recordedElsewhere ? <p>A refund is already recorded for this customer. Contact the team if you need the payment details.</p> : <><p><strong>Transaction reference:</strong> {record.reference || 'See staff record'}</p><p>Recorded: {date(record.completedAt)} · Dubai</p></>}<p>{demo ? 'Demo complete. Nothing was saved to the real refund tracker.' : 'The refund tracker is updated. This request cannot be marked Done again.'}</p></div>}
    </>}
    {error && <p role="alert" className="refund-link-error">{error}</p>}
    {!loading && token && <button type="button" className="refund-link-reload" onClick={load} disabled={busy}>Reload refund details</button>}
    {demo && <button type="button" className="refund-link-reload" onClick={() => { setReference(''); setNote(''); setConfirmed(false); load(); }}>Reset demo</button>}
    <p className="refund-link-help">{demo ? 'Example data only. This demo has no access to any customer or refund record.' : 'Private link for MATTER Accounts. No staff login is required. It only grants access to this refund.'}</p>
  </section></main>;
}
