import React, { useCallback, useEffect, useRef, useState } from 'react';
import './CollectionRefundComplete.css';
import './AccountsRefundPortal.css';
const date = value => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
const apiBase = () => process.env.REACT_APP_API_URL || (['localhost', '127.0.0.1'].includes(window.location.hostname) ? 'http://localhost:5000/api' : `${window.location.origin}/api`);
const demoRows = () => [26, 49].map((hours, index) => ({ id: `DEMO-${index + 1}`, customerId: `EXAMPLE-00${index + 1}`, customerName: index ? 'EXAMPLE CUSTOMER — Omar' : 'EXAMPLE CUSTOMER — Sara', amount: 155, collectedAt: new Date(Date.now() - hours * 3600000).toISOString(), version: 0 }));
const methodLabel = method => method === 'card' ? 'Credit/debit card' : 'Bank account';
export default function AccountsRefundPortal() {
  const [token] = useState(() => window.location.hash.slice(1));
  const [demo] = useState(() => !window.location.hash && new URLSearchParams(window.location.search).get('demo') === '1');
  const [rows, setRows] = useState([]), [total, setTotal] = useState(0), [page, setPage] = useState(1), [pages, setPages] = useState(0);
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [selected, setSelected] = useState(null), [receipt, setReceipt] = useState(null);
  const [reference, setReference] = useState(''), [method, setMethod] = useState(''), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [examples, setExamples] = useState(demoRows);
  const reading = useRef(0), saving = useRef(false), eventId = useRef('');
  const request = useCallback(async (action, input = {}) => {
    const response = await fetch(`${apiBase()}/collection-refund-portal/${action}`, { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, token }) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || 'Could not load the Accounts portal.');
    return result;
  }, [token]);
  const load = useCallback(async () => {
    const current = ++reading.current; setLoading(true); setError('');
    if (demo) { const matches = examples.filter(row => `${row.customerName} ${row.customerId}`.toLowerCase().includes(query.toLowerCase())); setRows(matches); setTotal(matches.length); setPages(1); setLoading(false); return; }
    if (!token) { setError('Open the private Accounts portal link from the email.'); setRows([]); setLoading(false); return; }
    try { const result = await request('list', { page, search: query }); if (current === reading.current) { setRows(result.data); setTotal(result.total); setPages(result.pages); } }
    catch (err) { if (current === reading.current) { setError(err.message); setRows([]); } }
    finally { if (current === reading.current) setLoading(false); }
  }, [demo, examples, token, page, query, request]);
  useEffect(() => { load(); return () => { reading.current++; }; }, [load]);
  useEffect(() => { if (selected || demo || !token) return undefined; const timer = setInterval(load, 60000); return () => clearInterval(timer); }, [selected, demo, token, load]);
  function choose(row) {
    setSelected(row); setReference(''); setMethod(''); setNote(''); setConfirmed(false); setReceipt(null); setError('');
    eventId.current = window.crypto?.randomUUID?.() || `accounts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  async function complete(event) {
    event.preventDefault(); if (saving.current) return;
    if (!['card', 'bank_account'].includes(method)) { setError('Choose credit/debit card or bank account.'); return; }
    if (!reference.trim()) { setError('Enter the transaction reference.'); return; }
    if (!confirmed) { setError('Confirm the refund as Jenniza.'); return; }
    saving.current = true; setBusy(true); setError(''); ++reading.current;
    try {
      const input = { deliveryId: selected.id, reference: reference.trim(), method, note, confirmed, version: selected.version, eventId: eventId.current };
      const result = demo ? { receipt: { ...selected, reference: input.reference, method, confirmedByName: 'Jenniza', completedAt: new Date().toISOString() } } : await request('complete', input);
      setReceipt(result.receipt); setSelected(null);
      if (demo) setExamples(previous => previous.filter(row => row.customerId !== selected.customerId));
      else if (page > 1 && rows.length === 1) setPage(previous => previous - 1);
      else await load();
    } catch (err) { setError(err.message); }
    finally { saving.current = false; setBusy(false); }
  }
  return <main className="refund-link-page"><section className="refund-link-card refund-portal-card">
    <div className="refund-link-brand">MATTER</div><p className="refund-link-eyebrow">JENNIZA · ACCOUNTS</p><h1>Bag refund portal</h1>
    <p>All pending bag refunds in one place. Record each refund after making its payment.</p>
    {demo && <p className="refund-link-receipt" role="status"><strong>DEMO ONLY — Example data. No real refunds or messages will change.</strong> Try both pending refunds, then reset.</p>}
    {receipt && <div className="refund-link-receipt" role="status"><h2>Refund recorded as Done</h2><p>{receipt.customerName} · {receipt.customerId}</p><p><strong>Transaction reference:</strong> {receipt.reference}<br /><strong>Refund destination:</strong> {methodLabel(receipt.method)}<br /><strong>Confirmed by:</strong> Jenniza<br />{date(receipt.completedAt)} · Dubai</p><p>{demo ? 'Demo only. Nothing was saved to the real tracker.' : 'The team’s refund tracker is updated.'}</p></div>}
    {error && <p role="alert" className="refund-link-error">{error}</p>}
    {selected ? <section aria-label="Complete selected refund"><button className="refund-link-reload" type="button" disabled={busy} onClick={() => { setSelected(null); setError(''); }}>Back to pending refunds</button><h2>{selected.customerName}</h2><p>{selected.customerId} · AED 155 · Collected {date(selected.collectedAt)} · Dubai</p><form onSubmit={complete}><fieldset disabled={busy}><legend className="sr-only">Refund confirmation</legend>
      <label htmlFor="portal-method">Refund destination (required)</label><select id="portal-method" required value={method} onChange={event => setMethod(event.target.value)}><option value="">Choose refund destination</option><option value="card">Credit/debit card</option><option value="bank_account">Bank account</option></select>
      <label htmlFor="portal-reference">Transaction reference (required)</label><input id="portal-reference" autoFocus required maxLength={200} autoComplete="off" value={reference} onChange={event => setReference(event.target.value)} />
      <label htmlFor="portal-note">Notes (optional)</label><textarea id="portal-note" maxLength={2000} value={note} onChange={event => setNote(event.target.value)} />
      <label className="refund-link-check"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I, Jenniza, confirm the AED 155 bag deposit has been refunded to the selected destination.</label><p className="refund-link-help">This records a refund only. It does not send money.</p><button type="submit">{busy ? 'Saving…' : 'Mark refund as Done'}</button>
    </fieldset></form></section> : <>
      <div className="refund-portal-summary"><strong>{total} pending {total === 1 ? 'refund' : 'refunds'}</strong><span>AED 155 per customer deposit</span></div>
      <form className="refund-portal-search" onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search.trim()); }}><label className="sr-only" htmlFor="portal-search">Search customer name or ID</label><input id="portal-search" value={search} maxLength={120} onChange={event => setSearch(event.target.value)} placeholder="Search customer name or ID" /><button type="submit" disabled={loading}>Search</button><button className="refund-link-reload" type="button" onClick={load} disabled={loading}>Refresh</button></form>
      {loading ? <p role="status">Loading pending refunds…</p> : !rows.length ? <p>{query ? 'No pending refunds match this search.' : error ? 'The portal could not load. Refresh to retry.' : 'No pending refunds. All eligible refunds are up to date.'}</p> : <ul className="refund-portal-list" aria-label="Pending bag refunds">{rows.map(row => { const hours = row.collectedAt ? Math.max(0, Math.floor((Date.now() - new Date(row.collectedAt)) / 3600000)) : null; return <li key={row.id}><div><h2>{row.customerName}</h2><p>{row.customerId} · AED 155</p><p>Collected: {date(row.collectedAt)} · Dubai</p><span className={`refund-link-status ${hours >= 48 ? 'refund-portal-overdue' : ''}`}>{hours === null ? 'Pending · Collection time missing' : `Pending · ${hours}h since collection`}</span></div><button type="button" onClick={() => choose(row)} aria-label={`Update refund for ${row.customerName}`}>Update refund</button></li>; })}</ul>}
      {pages > 1 && <nav className="refund-portal-pagination" aria-label="Refund pages"><button type="button" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page} of {pages}</span><button type="button" disabled={loading || page >= pages} onClick={() => setPage(value => value + 1)}>Next</button></nav>}
    </>}
    {demo && <button className="refund-link-reload" type="button" onClick={() => { setExamples(demoRows()); setSelected(null); setReceipt(null); setSearch(''); setQuery(''); setPage(1); }}>Reset demo</button>}
    <p className="refund-link-help">{demo ? 'Demo uses only page memory. No API calls, refunds, emails or Slack messages.' : 'Private Accounts portal · No staff login is required. This link grants access to all eligible pending bag refunds. Keep it within Accounts.'}</p>
  </section></main>;
}
