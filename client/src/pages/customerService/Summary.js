import RequestSettings from '../../components/customerService/RequestSettings';
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ArrowRight, Upload } from 'lucide-react';
import api from '../../utils/api';
import ServiceOperations from '../../components/customerService/ServiceOperations';
import GallaboxConnection from '../../components/customerService/GallaboxConnection';
import { serviceFilterSearch, displayName, errorMessage, filterParams, formatDubai, idOf, newRequestId, ResourceState, servicePath, toDubaiInput, unpack, useServiceResource } from '../../components/customerService/serviceUtils';

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
  const [availabilityDate, setAvailabilityDate] = useState(toDubaiInput(new Date()).slice(0, 10));
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
    setAvailabilityDate(member?.availabilityDate || toDubaiInput(new Date()).slice(0, 10));
  }
  async function save(event) {
    event.preventDefault(); if (busy || !selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.put(`${servicePath}/team`, { userId: selected, mode: members.find(member => idOf(member.userId) === selected)?.mode || 'reviewer', enabled, availableMinutes: Number(minutes), availabilityDate, displayName: label.trim() || displayName(candidates.find(item => idOf(item) === selected)), externalAuthorIds: externalAuthors.split(/[\n,]/).map(value => value.trim()).filter(Boolean) });
      team.refresh(); onChanged(); setNotice('Quality-review availability saved. Active reviews keep their owners.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <details><summary>Configure reviewer availability</summary><ResourceState loading={team.loading} error={team.error} />{error && <div className="cs-alert" role="alert">{error}</div>}{notice && <div className="cs-success" role="status">{notice}</div>}
    <form className="cs-form-stack" onSubmit={save} style={{ marginTop: 14 }}><label>Existing staff account<select aria-label="Reviewer account" value={selected} onChange={event => choose(event.target.value)} required><option value="">Select a reviewer</option>{candidates.filter(candidate => !members.some(member => idOf(member.userId) === idOf(candidate) && member.mode === 'supervisor')).map(candidate => <option key={idOf(candidate)} value={idOf(candidate)}>{displayName(candidate)}</option>)}</select></label><div className="cs-form-grid"><label>Display name<input value={label} maxLength={100} onChange={event => setLabel(event.target.value)} /></label><label>Planned quality-review time (minutes)<input type="number" min="0" max="1440" required value={minutes} onChange={event => setMinutes(event.target.value)} /></label><label>Service date · Dubai<input type="date" aria-label="Review availability service date" value={availabilityDate} onChange={event => setAvailabilityDate(event.target.value)} required/></label></div><label className="cs-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Available for new reviews</label><label>Verified source author IDs (one scoped ID per line)<textarea value={externalAuthors} onChange={event => setExternalAuthors(event.target.value)} placeholder="source:account-scope:author-id" maxLength={4000} /></label><p className="cs-muted">Map only verified source sender IDs to this staff account. Unmapped staff evidence cannot receive a handling grade. Enter agreed review time for the selected service date allowing for other duties and leave; zero minutes prevents new allocation.</p><button type="submit" disabled={busy || !selected || minutes === '' || !availabilityDate}>{busy ? 'Saving…' : 'Save reviewer availability'}</button></form>
    {canSetup && <p className="cs-muted" style={{ marginTop: 10 }}>Supervisor grants use the separate administrator setup path.</p>}</details>;
}

export default function Summary({ capabilities, filters, epoch, onRefresh }) {
  const report = useServiceResource('/summary', filterParams(filters), epoch);
  const metrics=useServiceResource(capabilities.supervise?'/metrics':null,filterParams(filters),epoch);
  const performance=metrics.data;
  useEffect(()=>{if(!capabilities.supervise)return undefined;const timer=setInterval(metrics.refresh,30000);return()=>clearInterval(timer);},[capabilities.supervise,metrics.refresh]);
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
      setNotice(`${result?.allocated ?? result?.assignments?.length ?? 'New'} reviews allocated.`);
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
  return <><RequestSettings capabilities={capabilities} onChanged={onRefresh}/><div className="cs-toolbar"><h2>{capabilities.supervise ? 'Customer service overview' : 'My follow-ups & reviews'}</h2><button onClick={download} disabled={Boolean(busy) || report.loading || !data}><Download size={16}/>{busy === 'export' ? 'Preparing…' : 'Download Excel'}</button></div><ResourceState loading={report.loading} error={report.error}/>{error && <div className="cs-alert" role="alert">{error}</div>}{notice && <div className="cs-success" role="status">{notice}</div>}
    {capabilities.supervise&&<ServiceOperations resource={metrics}/>}
    <div className="cs-grid"><section className="cs-card"><details><summary>Internal quality reviews</summary><p className="cs-muted">Reviewing past conversations, not replying to customers. Assignments here are separate from Gallabox chat ownership.</p>{data && <div className="cs-table-wrap"><table><thead><tr><th>Reviewer</th><th>Assigned</th><th>Reviewed</th><th>Remaining</th></tr></thead><tbody>{rows.filter(row=>row.assigned||row.reviewed||row.remaining).map(row=><tr key={idOf(row.userId)}><td><strong>{row.displayName || 'Reviewer'}</strong></td><td>{row.assigned ?? '—'}</td><td>{row.reviewed ?? '—'}</td><td>{row.remaining ?? '—'}</td></tr>)}</tbody></table>{!rows.some(row=>row.assigned||row.reviewed||row.remaining) && <p className="cs-muted">No internal review assignments or submissions in these dates.</p>}</div>}<div className="cs-form-actions">{capabilities.supervise && <button onClick={allocate} disabled={Boolean(busy)}>{busy === 'allocate' ? 'Balancing…' : 'Balance new reviews'}</button>}<Link to={`/customer-service/chats${serviceFilterSearch(filters)}`}>Review conversations <ArrowRight size={13}/></Link></div></details></section>
    <section className="cs-card"><h2>Staff follow-ups</h2><p className="cs-muted">Actions recorded here · selected dates</p><div className="cs-metrics">{[['Open',data?.actions?.open],['Overdue',data?.actions?.overdue],['Unassigned',data?.actions?.unassigned]].map(([label,value])=><div className="cs-metric" key={label}><strong>{value ?? '—'}</strong><span>{label}</span></div>)}</div><Link to={`/customer-service/problems${serviceFilterSearch(filters)}`}>View actions</Link></section></div>
    <section className="cs-card" style={{marginTop:18}}><details><summary>Sources and settings</summary><div className="cs-grid" style={{marginTop:16}}><div className="cs-stack">{capabilities.supervise && <GallaboxConnection onImported={()=>{report.refresh();onRefresh();}}/>}<section className="cs-card"><h3>Coverage</h3><dl className="cs-context-list"><dt>Eligible</dt><dd>{data?.coverage?.eligible ?? '—'}</dd><dt>Reviewed</dt><dd>{data?.coverage?.reviewed ?? '—'}</dd><dt>Missing evidence</dt><dd>{data?.coverage?.insufficient ?? '—'}</dd><dt>Needs recheck</dt><dd>{data?.coverage?.stale ?? '—'}</dd><dt>Last capture</dt><dd>{formatDubai(performance?.sync?.lastSuccessAt || data?.capture?.lastSuccessAt)}</dd></dl><p className="cs-muted">{performance?.sync?.mode==='cloud'?'Gallabox history stored in Supabase':data?.capture?.status || 'Capture not verified'} · Partial history</p>{capabilities.supervise && performance?.sync?.mode!=='cloud' && <ImportCapture onImported={()=>{report.refresh();onRefresh();}}/>}</section></div>{capabilities.supervise && <section className="cs-card"><h3>Quality-review setup</h3><TeamControls epoch={epoch} onChanged={onRefresh} canSetup={capabilities.setup}/></section>}</div></details></section></>;
}
