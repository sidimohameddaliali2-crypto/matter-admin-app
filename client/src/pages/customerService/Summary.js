import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ArrowRight, Upload } from 'lucide-react';
import api from '../../utils/api';
import { displayName, errorMessage, filterParams, formatDubai, idOf, newRequestId, ResourceState, servicePath, unpack, useServiceResource } from '../../components/customerService/serviceUtils';

function ImportCapture({ onImported }) {
  const [messages, setMessages] = useState(null);
  const [fileName, setFileName] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [scope, setScope] = useState('matter');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const request = useRef(null);
  async function selectFile(event) {
    setError(''); setMessages(null); setResult(null); request.current = null;
    const file = event.target.files?.[0]; setFileName(file?.name || '');
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError('Use a JSON capture smaller than 5 MB.'); return; }
    try {
      const parsed = JSON.parse(await file.text());
      const rows = Array.isArray(parsed) ? parsed : parsed.messages;
      if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('The file must contain between 1 and 500 normalized messages.');
      if (rows.some(row => !row || typeof row !== 'object' || !row.externalMessageId || !row.externalConversationId || !row.sentAt || !/(Z|[+-]\d{2}:\d{2})$/i.test(row.sentAt) || Number.isNaN(new Date(row.sentAt).getTime()))) throw new Error('Every message needs externalMessageId, externalConversationId and a valid sentAt timestamp with timezone.');
      setMessages(rows);
      if (!Array.isArray(parsed)) setRange({ from: (parsed.from || '').slice(0, 10), to: (parsed.to || '').slice(0, 10) });
    } catch (failure) { setError(errorMessage(failure, 'This is not a supported JSON capture.')); }
  }
  async function submit(event) {
    event.preventDefault(); if (busy || !messages || !range.from || !range.to) return;
    setBusy(true); setError('');
    const payload = { source: 'gallabox_export', scope: scope.trim(), messages, from: range.from, to: range.to, fileName };
    const signature = JSON.stringify(payload);
    if (request.current?.signature !== signature) request.current = { signature, id: newRequestId() };
    try {
      const saved = unpack(await api.post(`${servicePath}/import`, { ...payload, requestId: request.current.id }));
      setResult(saved); setMessages(null); request.current = null; onImported();
    } catch (failure) { setError(errorMessage(failure, 'Import failed. No complete capture has been confirmed.')); }
    finally { setBusy(false); }
  }
  return <details className="cs-import"><summary>Import a dated conversation capture</summary><p className="cs-muted" style={{ marginTop: 10 }}>Import only an authorized normalized JSON export. Source IDs and recorded authors are preserved. This does not connect or change the live inbox.</p>
    {error && <div className="cs-alert" role="alert">{error}</div>}{result && <div className="cs-success" role="status">Capture saved. Received {result.received ?? 'unknown'} · inserted {result.inserted ?? 'unknown'} · duplicates {result.duplicates ?? 'unknown'} · unlinked {result.unlinked ?? 'unknown'}. Inspect capture coverage above.</div>}
    <form onSubmit={submit} className="cs-form-stack"><label>JSON capture<input className="cs-file" type="file" accept="application/json,.json" onChange={selectFile} disabled={busy} /></label><div className="cs-form-grid"><label>Source account scope<input value={scope} required maxLength={100} onChange={event => setScope(event.target.value)} /></label><div /><label>Coverage from (Dubai)<input type="date" required value={range.from} max={range.to || undefined} onChange={event => setRange(previous => ({ ...previous, from: event.target.value }))} /></label><label>Coverage to (Dubai)<input type="date" required value={range.to} min={range.from || undefined} onChange={event => setRange(previous => ({ ...previous, to: event.target.value }))} /></label></div>{messages && <p className="cs-muted">{messages.length} messages ready for validation · {fileName}</p>}<button type="submit" disabled={busy || !messages || !scope.trim() || !range.from || !range.to}><Upload size={15} />{busy ? 'Importing…' : 'Import capture'}</button></form>
    <details style={{ marginTop: 14 }}><summary>Normalized message format</summary><pre>{JSON.stringify({ messages: [{ externalMessageId: 'source-message-id', externalConversationId: 'source-thread-id', customerId: 'Matter customer ID if linked', customerName: 'Source name', externalAuthorId: 'source-author-id', authorName: 'Recorded author', authorType: 'customer', sentAt: '2026-11-06T08:00:00Z', type: 'text', text: 'Original message text' }] }, null, 2)}</pre><p className="cs-muted">Use authorType customer, staff, bot or unknown as recorded; do not infer a staff identity from a name.</p></details></details>;
}

function TeamControls({ epoch, onChanged, canSetup }) {
  const team = useServiceResource('/team', {}, epoch);
  const [selected, setSelected] = useState('');
  const [minutes, setMinutes] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [label, setLabel] = useState('');
  const [externalAuthors, setExternalAuthors] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const candidates = team.data?.candidates || team.data?.users || [];
  const members = team.data?.members || [];
  function choose(value) {
    setSelected(value); setNotice('');
    const member = members.find(item => idOf(item.userId) === value);
    setMinutes(member?.availableMinutes == null ? '' : String(member.availableMinutes));
    setEnabled(member?.enabled !== false); setLabel(member?.displayName || '');
    setExternalAuthors((member?.externalAuthorIds || []).join('\n'));
  }
  async function save(event) {
    event.preventDefault(); if (busy || !selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.put(`${servicePath}/team`, { userId: selected, mode: 'reviewer', enabled, availableMinutes: Number(minutes), displayName: label.trim() || displayName(candidates.find(item => idOf(item) === selected)), externalAuthorIds: externalAuthors.split(/[\n,]/).map(value => value.trim()).filter(Boolean) });
      team.refresh(); onChanged(); setNotice('Review availability saved. Active reviews keep their owners.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <details><summary>Configure reviewer availability</summary><ResourceState loading={team.loading} error={team.error} />{error && <div className="cs-alert" role="alert">{error}</div>}{notice && <div className="cs-success" role="status">{notice}</div>}
    <form className="cs-form-stack" onSubmit={save} style={{ marginTop: 14 }}><label>Existing staff account<select value={selected} onChange={event => choose(event.target.value)} required><option value="">Select a reviewer</option>{candidates.filter(candidate => !members.some(member => idOf(member.userId) === idOf(candidate) && member.mode === 'supervisor')).map(candidate => <option key={idOf(candidate)} value={idOf(candidate)}>{displayName(candidate)}</option>)}</select></label><div className="cs-form-grid"><label>Display name<input value={label} maxLength={100} onChange={event => setLabel(event.target.value)} /></label><label>Available review minutes<input type="number" min="0" max="1440" required value={minutes} onChange={event => setMinutes(event.target.value)} /></label></div><label className="cs-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Available for new reviews</label><label>Verified source author IDs (one scoped ID per line)<textarea value={externalAuthors} onChange={event => setExternalAuthors(event.target.value)} placeholder="source:account-scope:author-id" maxLength={4000} /></label><p className="cs-muted">Map only verified source sender IDs to this staff account. Unmapped staff evidence cannot receive a handling grade. Enter agreed review time allowing for other duties and leave; zero minutes prevents new allocation.</p><button type="submit" disabled={busy || !selected || minutes === ''}>{busy ? 'Saving…' : 'Save reviewer availability'}</button></form>
    {canSetup && <p className="cs-muted" style={{ marginTop: 10 }}>Supervisor grants use the separate administrator setup path.</p>}</details>;
}

export default function Summary({ capabilities, filters, epoch, onRefresh }) {
  const report = useServiceResource('/summary', filterParams(filters), epoch);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const allocationRequest = useRef(null);
  const data = report.data;
  const rows = data?.reviewWorkload || [];
  async function allocate() {
    if (lock.current) return; lock.current = true; setBusy('allocate'); setError(''); setNotice('');
    if (!allocationRequest.current) allocationRequest.current = newRequestId();
    try {
      const result = unpack(await api.post(`${servicePath}/allocate`, { requestId: allocationRequest.current }));
      setNotice(`${result?.allocated ?? result?.assignments?.length ?? 'New'} reviews allocated. Existing active work stays with its owner.`);
      allocationRequest.current = null; report.refresh(); onRefresh();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setBusy(''); }
  }
  async function download() {
    if (lock.current) return; lock.current = true; setBusy('export'); setError('');
    try {
      const response = await api.get(`${servicePath}/export.xlsx`, { params: filterParams(filters), responseType: 'blob' });
      const blob = response.data instanceof Blob ? response.data : new Blob([response.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'matter-customer-service.xlsx'; link.click(); URL.revokeObjectURL(url);
    } catch (failure) { setError(errorMessage(failure, 'Excel export failed. Please try again.')); }
    finally { lock.current = false; setBusy(''); }
  }
  return <><div className="cs-toolbar"><div><p className="cs-eyebrow">{capabilities.supervise ? 'Team overview' : 'My overview'}</p><h2>Customer service, at a glance</h2></div><button onClick={download} disabled={Boolean(busy) || report.loading || !data}><Download size={16} />{busy === 'export' ? 'Preparing Excel…' : 'Download Excel'}</button></div><ResourceState loading={report.loading} error={report.error} />{error && <div className="cs-alert" role="alert">{error}</div>}{notice && <div className="cs-success" role="status">{notice}</div>}
    <div className="cs-grid"><div className="cs-stack"><section className="cs-card"><p className="cs-eyebrow">Reviews</p><h2>Review workload</h2><p className="cs-muted">Planned review time sets the share of new work. A submitted review does not close a customer follow-up.</p>{data && <div className="cs-table-wrap"><table><thead><tr><th>{capabilities.supervise ? 'Reviewer' : 'My reviews'}</th><th>Planned</th><th>Assigned</th><th>Reviewed</th><th>Remaining</th></tr></thead><tbody>{rows.map(row => <tr key={idOf(row.userId)}><td><strong>{row.displayName || 'Reviewer'}</strong></td><td>{row.availableMinutes == null ? 'Not set' : `${row.availableMinutes} min`}</td><td>{row.assigned ?? 'Unknown'}</td><td>{row.reviewed ?? 'Unknown'}</td><td>{row.remaining ?? 'Unknown'}</td></tr>)}</tbody></table>{!rows.length && <p className="cs-muted" style={{ paddingTop: 20 }}>No review workload recorded for this scope.</p>}</div>}<div className="cs-form-actions" style={{ marginTop: 13 }}>{capabilities.supervise && <button onClick={allocate} disabled={Boolean(busy)}>{busy === 'allocate' ? 'Balancing…' : 'Balance new reviews'}</button>}<Link to="/customer-service/chats">Go to my reviews <ArrowRight size={13} style={{ display: 'inline' }}/></Link></div>{capabilities.supervise && <p className="cs-muted" style={{ marginTop: 12 }}>Active reviews stay with their owners. Unavailable staff receive no new allocation.</p>}</section>
      <section className="cs-card"><p className="cs-eyebrow">Customer follow-ups</p><h2>Actions to see through</h2><div className="cs-metrics">{[['Open', data?.actions?.open], ['Overdue', data?.actions?.overdue], ['Unassigned', data?.actions?.unassigned]].map(([label, value]) => <div className="cs-metric" key={label}><strong>{value ?? '—'}</strong><span>{label} actions</span></div>)}</div><Link to="/customer-service/problems">Open the follow-up queue</Link><p className="cs-muted" style={{ marginTop: 12 }}>Completion requires the actual result and supporting evidence.</p></section>
      {capabilities.supervise && <section className="cs-card"><h3>Review pool</h3><TeamControls epoch={epoch} onChanged={onRefresh} canSetup={capabilities.setup} /></section>}</div>
      <div className="cs-stack"><section className="cs-card"><p className="cs-eyebrow">Evidence coverage</p><h2>What the figures cover</h2><dl className="cs-context-list"><dt>Eligible cases</dt><dd>{data?.coverage?.eligible ?? 'Unknown'}</dd><dt>Reviewed cases</dt><dd>{data?.coverage?.reviewed ?? 'Unknown'}</dd><dt>Insufficient evidence</dt><dd>{data?.coverage?.insufficient ?? 'Unknown'}</dd><dt>New evidence to check</dt><dd>{data?.coverage?.stale ?? 'Unknown'}</dd></dl><p className="cs-muted" style={{ marginTop: 18 }}>Missing evidence is not a poor rating. Open-case handling remains provisional. Message volume is not a quality score.</p></section>
      <section className="cs-card"><p className="cs-eyebrow">Source health</p><h3>Captured conversations</h3><div className="cs-notice">{data?.capture?.status || 'Capture status not yet verified'}. Continuous live capture is not confirmed by a successful import.</div><dl className="cs-context-list"><dt>Last saved capture</dt><dd>{formatDubai(data?.capture?.lastSuccessAt)}</dd><dt>Coverage from</dt><dd>{data?.capture?.from || 'Not recorded'}</dd><dt>Coverage to</dt><dd>{data?.capture?.to || 'Not recorded'}</dd></dl><p className="cs-muted" style={{ marginTop: 15 }}>Partial captures may omit replies, attachments and assignment history. Recorded source evidence stays separate from verified customer resolution.</p>{capabilities.supervise && <ImportCapture onImported={() => { report.refresh(); onRefresh(); }} />}</section></div></div></>;
}
