import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardPaste, Plus, Search, ShoppingBag, X } from 'lucide-react';
import Dialog from '@mui/material/Dialog';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import api from '../utils/api';
import { parseCollectionAddress } from '../utils/collectionAddress';
import CollectionRefundTracker from '../components/bags/CollectionRefundTracker';
import { dubaiDateKey, collectionIsOpen, exportCollectionRows } from '../utils/collectionOperations';
import './Collections.css';

const emptyForm = () => ({ customerSource: 'manual', customerId: '', customerName: '', phone: '', address: '', addressLabel: '', latitude: '', longitude: '', collectionDate: '', refundRequestedAfterCollection: false, notes: '' });
const formatDate = value => new Date(value).toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium' });

export default function Collections() {
  const [form, setForm] = useState(emptyForm);
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [records, setRecords] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [view, setView] = useState('open'), [searchText, setSearchText] = useState(''), [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState(''), [dateTo, setDateTo] = useState(''), [driver, setDriver] = useState('');
  const [people, setPeople] = useState({ drivers: [], owners: [] }), [peopleError, setPeopleError] = useState('');
  const [summary, setSummary] = useState(null), [summaryError, setSummaryError] = useState('');
  const [duplicates, setDuplicates] = useState([]), [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false), [duplicateReason, setDuplicateReason] = useState('');
  const [exporting, setExporting] = useState(false);
  const [filterResetKey, setFilterResetKey] = useState(0);
  const listRequest = useRef(0);
  useEffect(() => { setDuplicates([]); setDuplicateAcknowledged(false); setDuplicateReason(''); }, [form.customerName, form.customerId, form.phone, form.collectionDate]);
  const addressInput = useRef(null);
  const submitting = useRef(false);
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const selectedDate = form.collectionDate ? new Date(`${form.collectionDate}T12:00:00`) : undefined;
  function selectDate(date) {
    if (!date || ![2, 5, 6].includes(date.getDay())) return;
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (dateKey < dubaiDateKey()) return;
    update('collectionDate', dateKey);
    setCalendarOpen(false); setError('');
  }

  const refreshSummary = useCallback(async () => {
    try { const { data } = await api.get('/collections/summary'); setSummary(data); setSummaryError(''); }
    catch { setSummary(null); setSummaryError('Work summary unavailable. Refresh to retry.'); }
  }, []);
  useEffect(() => { refreshSummary(); }, [refreshSummary]);
  useEffect(() => { api.get('/collections/people').then(({ data }) => setPeople({ drivers: data.drivers || [], owners: data.owners || [] })).catch(() => setPeopleError('Staff filters unavailable. Refresh the page to retry.')); }, []);
  useEffect(() => { const timer = setTimeout(() => { setSearch(searchText.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [searchText]);
  const load = useCallback(async () => {
    const requestId = ++listRequest.current;
    setLoading(true); setListError('');
    try {
      const { data } = await api.get('/collections', { params: { page, view, search, dateFrom, dateTo, driver } });
      if (requestId !== listRequest.current) return;
      setRecords(data.data); setPages(data.pages); setTotal(data.total);
    } catch (err) { if (requestId === listRequest.current) setListError(err.response?.data?.message || 'Could not load collection requests.'); }
    finally { if (requestId === listRequest.current) setLoading(false); }
  }, [page, view, search, dateFrom, dateTo, driver]);
  useEffect(() => { load(); return () => { listRequest.current++; }; }, [load]);
  useEffect(() => { if (formOpen) return undefined; const timer = setInterval(() => { load(); refreshSummary(); }, 30000); return () => clearInterval(timer); }, [load, refreshSummary, formOpen]);
  async function exportRows() {
    setExporting(true); setListError('');
    try { await exportCollectionRows(api, { view, search, dateFrom, dateTo, driver }, 'collections.csv'); }
    catch { setListError('Could not export. Try a narrower date range and retry.'); }
    finally { setExporting(false); }
  }
  function clearFilters() { setSearchText(''); setSearch(''); setDateFrom(''); setDateTo(''); setDriver(''); setPage(1); setFilterResetKey(current => current + 1); }

  useEffect(() => {
    let active = true;
    setCustomers([]); setSearchError(''); setSearching(false);
    if (form.customerId || query.trim().length < 2) return undefined;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.get('/customers', { params: { search: query.trim(), limit: 15 } });
        if (active) setCustomers(data.data || []);
      } catch (err) { if (active) setSearchError('Customer search failed. Retry or type the customer name below.'); }
      finally { if (active) setSearching(false); }
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [query, form.customerId]);

  function selectCustomer(customer) {
    const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.customerId;
    const sameAddress = customer.gpsLocation?.address?.trim() === customer.address?.trim();
    setForm(current => ({ ...current, customerSource: 'internal', customerId: customer.customerId, customerName: name, phone: customer.phone || '',
      address: customer.address || '', addressLabel: '',
      latitude: sameAddress ? customer.gpsLocation?.lat ?? '' : '', longitude: sameAddress ? customer.gpsLocation?.lng ?? '' : '' }));
    setQuery(name); setCustomers([]);
  }

  function captureAddress(text) {
    try {
      const parsed = parseCollectionAddress(text);
      setForm(current => ({ ...current, ...parsed }));
      setError('');
      setNotice('Address captured. Review the address and coordinates before creating the request.');
    } catch (err) { setError(err.message); }
  }
  async function pasteAddress() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { addressInput.current?.focus(); setNotice('Copy an address, then paste it into the Collection address field. The details will fill automatically.'); return; }
      captureAddress(text);
    } catch {
      addressInput.current?.focus();
      setNotice('Paste directly into the Collection address field (Ctrl+V). The address and coordinates will fill automatically.');
    }
  }
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    if (!selectedDate || ![2, 5, 6].includes(selectedDate.getDay())) { setError('Choose a collection date on Tuesday, Friday or Saturday.'); setCalendarOpen(true); return; }
    if (form.collectionDate < dubaiDateKey()) { setError('Choose today or a later date in Dubai.'); return; }
    submitting.current = true; setSaving(true); setError(''); setNotice('');
    try {
      await api.post('/collections', { ...form, duplicateAcknowledged, duplicateReason });
      setForm(emptyForm()); setQuery(''); setCalendarOpen(false);
      setFormOpen(false);
      setDuplicates([]); setDuplicateAcknowledged(false); setDuplicateReason(''); refreshSummary();
      setNotice('Collection request created. It is ready for assignment in Deliveries.');
      if (page === 1) await load(); else setPage(1);
    } catch (err) { setError(err.response?.data?.message || 'Could not create the request. Your entries have been kept.'); if (err.response?.data?.code === 'POSSIBLE_DUPLICATE') { setDuplicates(err.response.data.duplicates || []); setDuplicateAcknowledged(false); } }
    finally { submitting.current = false; setSaving(false); }
  }

  return <div className="collection-page">
    <header className="collection-heading"><div><span className="collection-eyebrow">OPERATIONS</span><h1>Collection</h1><p>Create bag collection requests and track their progress.</p></div><button type="button" className="collection-primary collection-add-button" onClick={() => { setNotice(''); setError(''); setFormOpen(true); }}><Plus size={18} /> Add collection</button></header>
    <section className="collection-work-summary" aria-label="Work needing attention">
      <h2>{summary ? `${summary.openCount} open collections · ${summary.pendingRefunds} pending refund${summary.pendingRefunds === 1 ? '' : 's'}` : 'Work needing attention'}</h2>
      <p className="collection-hint">All records · Dubai · {summary?.asOf ? `Updated ${new Date(summary.asOf).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' })}` : 'Summary is separate from the filters below.'}</p>
      {summaryError && <p role="alert">{summaryError}</p>}
      {summary && <div className="collection-summary-counts"><a href="#collection-requests" onClick={() => { clearFilters(); setView('open'); setDriver('unassigned'); }}>{summary.unassigned} without a driver</a><a href="#collection-requests" onClick={() => { clearFilters(); setView('open'); setDateTo(new Date(Date.parse(dubaiDateKey()) - 86400000).toISOString().slice(0, 10)); }}>{summary.pastDate} past their scheduled date</a><a href="#collection-refunds" onClick={clearFilters}>{summary.pendingRefunds} awaiting refund</a></div>}
      <details><summary>About these counts</summary><p className="collection-hint">Counts cover all records, independent of the filters below. A pending refund is a completed collection with a refund request. An empty queue does not confirm every deposit has been repaid. Past scheduled date means the request is still open after its Dubai collection date; it is not a driver performance judgement.</p></details>
    </section>
    <section className="collection-filters" aria-label="Customer and collection date filters">
      <div><label htmlFor="collection-list-search">Find customer</label><input id="collection-list-search" value={searchText} maxLength={120} placeholder="Name, phone or customer ID" onChange={event => setSearchText(event.target.value)} /></div>
      <div><label htmlFor="collection-date-from">Collection date from · Dubai</label><input id="collection-date-from" type="date" value={dateFrom} onInput={event => { setDateFrom(event.currentTarget.value); setPage(1); }} onChange={event => { setDateFrom(event.target.value); setPage(1); }} /></div>
      <div><label htmlFor="collection-date-to">Collection date to · Dubai</label><input id="collection-date-to" type="date" value={dateTo} min={dateFrom || undefined} onInput={event => { setDateTo(event.currentTarget.value); setPage(1); }} onChange={event => { setDateTo(event.target.value); setPage(1); }} /></div>
      <button type="button" className="collection-secondary" onClick={clearFilters}>Clear filters</button>
    </section>
    {peopleError && <p role="alert" className="collection-error">{peopleError}</p>}
    {!formOpen && notice && <p className="collection-notice" role="status">{notice}</p>}
    <Dialog open={formOpen} onClose={() => { if (!saving) setFormOpen(false); }} disableEscapeKeyDown={saving} fullWidth maxWidth="sm" aria-labelledby="collection-modal-title">
      <section className="collection-page collection-card collection-modal-card">
        <div className="collection-modal-heading"><h2 id="collection-modal-title">New collection request</h2><button type="button" className="collection-secondary" aria-label="Close add collection" disabled={saving} onClick={() => setFormOpen(false)}><X size={18} /></button></div>
        <form onSubmit={submit}>
          <fieldset disabled={saving}>
            <legend className="sr-only">Collection request details</legend>
            <div>
              <label htmlFor="collection-customer">Find an internal customer</label>
              <div className="collection-search"><Search size={17} /><input id="collection-customer" autoFocus value={query} autoComplete="off" placeholder="Search name, phone, email or customer ID" onChange={event => { setQuery(event.target.value); setForm(current => ({ ...current, customerSource: 'manual', customerId: '', ...(current.customerId ? { customerName: '', phone: '', address: '', addressLabel: '', latitude: '', longitude: '' } : {}) })); }} /></div>
              <div aria-live="polite" className="collection-hint">{form.customerId ? `Selected: ${form.customerName} · ${form.customerId}` : searching ? 'Searching…' : searchError || (query.trim().length >= 2 && !customers.length ? 'No matches. Type the customer name below.' : 'Search and select a customer to fill their information automatically.')}</div>
              {!!customers.length && <ul className="collection-results">{customers.map(customer => <li key={customer.customerId}><button type="button" onClick={() => selectCustomer(customer)}><strong>{[customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.customerId}</strong><span>{customer.customerId} · {customer.phone || customer.email || 'No contact saved'}</span></button></li>)}</ul>}
            </div>
            <label htmlFor="collection-name">Customer name</label><input id="collection-name" required maxLength={200} readOnly={!!form.customerId} value={form.customerName} onChange={event => update('customerName', event.target.value)} placeholder="Type the full name if no customer is found" />
            <p className="collection-hint">{form.customerId ? 'Filled from the selected customer. Clear the search to enter a different name.' : 'If the customer is not found, enter their name here. No new customer record will be created.'}</p>
            <label htmlFor="collection-phone">Contact phone <small>(optional)</small></label><input id="collection-phone" type="tel" maxLength={50} value={form.phone} onChange={event => update('phone', event.target.value)} placeholder="+971" />
            <div className="collection-address-heading"><label htmlFor="collection-address">Collection address</label><button type="button" className="collection-secondary" onClick={pasteAddress}><ClipboardPaste size={16} /> Paste address</button></div>
            <textarea ref={addressInput} id="collection-address" required maxLength={2000} value={form.address} onPaste={event => { const text = event.clipboardData.getData('text/plain'); if (text.trim()) { event.preventDefault(); captureAddress(text); } }} onChange={event => setForm(current => ({ ...current, address: event.target.value, latitude: '', longitude: '' }))} placeholder="Type or paste the full address here to capture its details automatically" />
            <label htmlFor="collection-label">Address label <small>(optional)</small></label><input id="collection-label" value={form.addressLabel} maxLength={100} onChange={event => update('addressLabel', event.target.value)} placeholder="Home / Work" />
            <div className="collection-pair"><div><label htmlFor="collection-lat">Latitude</label><input id="collection-lat" type="number" step="any" min="-90" max="90" value={form.latitude} onChange={event => update('latitude', event.target.value)} /></div><div><label htmlFor="collection-lng">Longitude</label><input id="collection-lng" type="number" step="any" min="-180" max="180" value={form.longitude} onChange={event => update('longitude', event.target.value)} /></div></div>
            <p className="collection-hint">Copied coordinates are captured automatically. Without a pin, dispatch can add one before assignment.</p>
            {form.latitude !== '' && form.longitude !== '' && <a target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${encodeURIComponent(form.latitude)},${encodeURIComponent(form.longitude)}`}>Check map pin ↗</a>}
            <label htmlFor="collection-date">Collection date · Dubai</label>
            <button id="collection-date" type="button" className="collection-secondary" aria-expanded={calendarOpen} aria-controls="collection-calendar" onClick={() => setCalendarOpen(current => !current)}>{selectedDate ? selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'Choose a collection date'}</button>
            <p className="collection-hint">Collections are available every Tuesday, Friday and Saturday.</p>
            <p className="collection-hint">New requests can only be scheduled for today or later in Dubai.</p>
            {calendarOpen && <div id="collection-calendar" className="collection-calendar"><DayPicker mode="single" selected={selectedDate} defaultMonth={selectedDate} onSelect={selectDate} disabled={[{ dayOfWeek: [0, 1, 3, 4] }, { before: new Date(`${dubaiDateKey()}T00:00:00`) }]} weekStartsOn={1} /></div>}
            <label className="collection-checkbox"><input type="checkbox" checked={form.refundRequestedAfterCollection} onChange={event => update('refundRequestedAfterCollection', event.target.checked)} /><span><strong>Bag refund requested after collection</strong><small>Once collection is completed, this request appears as Pending in Refund tracking.</small></span></label>
            <label htmlFor="collection-notes">Collection notes <small>(optional)</small></label><textarea id="collection-notes" maxLength={2000} value={form.notes} onChange={event => update('notes', event.target.value)} placeholder="Access instructions or collection details" />
            {!!duplicates.length && <section className="collection-duplicate-warning" aria-label="Possible duplicate requests"><h3>Review possible duplicates</h3><p>A matching customer or phone already has an open request on this date. This is a warning, not a confirmed duplicate.</p><ul>{duplicates.map(row => <li key={row._id}><Link to={`/deliveries/${row._id}`} target="_blank" rel="noreferrer">{row.customerName} · {formatDate(row.scheduledTime)} · {row.status}</Link></li>)}</ul><label className="collection-checkbox"><input type="checkbox" checked={duplicateAcknowledged} onChange={event => setDuplicateAcknowledged(event.target.checked)} />I reviewed these requests and need another collection</label><label htmlFor="collection-duplicate-reason">Reason for another request</label><textarea id="collection-duplicate-reason" maxLength={1000} required={duplicateAcknowledged} value={duplicateReason} onChange={event => setDuplicateReason(event.target.value)} /></section>}
            {error && <p className="collection-error" role="alert">{error}</p>}
            <button type="submit" className="collection-primary" disabled={!!duplicates.length && (!duplicateAcknowledged || !duplicateReason.trim())}>{saving ? 'Creating request…' : duplicates.length ? 'Create additional request' : 'Create collection request'}</button>
          </fieldset>
        </form>
        {notice && <p className="collection-notice" role="status">{notice}</p>}
      </section>
    </Dialog>
    <div className="collection-grid">
      <section id="collection-requests" className="collection-card collection-register"><div className="collection-register-heading"><h2><ShoppingBag size={19} /> Collection requests <span>{total}</span></h2><button type="button" className="collection-secondary" onClick={() => { load(); refreshSummary(); }} disabled={loading}>Refresh</button></div>
        <div className="collection-refund-filters" aria-label="Collection status filters">{[['open', 'Open'], ['history', 'History'], ['all', 'All']].map(([value, text]) => <button key={value} type="button" className="collection-secondary" aria-pressed={view === value} onClick={() => { setView(value); setPage(1); }}>{text}</button>)}</div>
        <label htmlFor="collection-driver-filter">Driver</label><select id="collection-driver-filter" value={driver} onChange={event => { setDriver(event.target.value); setPage(1); }}><option value="">All drivers</option><option value="unassigned">Without a driver</option>{people.drivers.map(person => <option key={person._id} value={person._id}>{person.name}</option>)}</select>
        <button className="collection-secondary collection-export" type="button" onClick={exportRows} disabled={loading || exporting}>{exporting ? 'Exporting…' : 'Export matching collections'}</button>
        <p className="collection-hint">Assign requests in Deliveries. Collection and driver progress appear here.</p>
        {listError ? <p role="alert" className="collection-error">{listError}</p> : loading ? <p role="status">Loading requests…</p> : !records.length ? <div className="collection-empty"><ShoppingBag size={32} /><h3>No matching {view === 'open' ? 'open ' : ''}collections</h3><p>Change the filters or create a bag collection request.</p></div> : <ul className="collection-records collection-scroll-records" tabIndex={0} aria-label="Matching collection requests">{records.map(record => <li key={record._id}>
          <div className="collection-record-title"><strong>{record.customerName}</strong><span className={`collection-status ${['collected', 'completed', 'delivered'].includes(record.status) ? 'is-complete' : ''}`}>{record.status.replace(/_/g, ' ')}</span></div>
          <p>{record.address || 'Address not recorded'}</p><time>{formatDate(record.scheduledTime)} · Dubai</time>
          {record.possibleDuplicateId && <p className="collection-duplicate-warning"><strong>Possible duplicate request.</strong> A matching customer or phone has another open collection on this date. <Link to={`/deliveries/${record.possibleDuplicateId}`}>Review the other request</Link> before dispatch. This is not a confirmed duplicate.</p>}
          <div className="collection-record-meta"><span>{record.collectionRequest?.refundRequestedAfterCollection === true ? 'Refund requested after collection' : record.collectionRequest?.refundRequestedAfterCollection === false ? 'Refund not requested' : 'Refund request: not recorded'}</span>{record.collectionRequest?.phone && <a href={`tel:${record.collectionRequest.phone}`}>{record.collectionRequest.phone}</a>}</div>
          {record.driver && <p className="collection-hint">Driver: {[record.driver.profile?.firstName, record.driver.profile?.lastName].filter(Boolean).join(' ')}</p>}
          {collectionIsOpen(record.status) && <p className="collection-next-action"><strong>Next:</strong> {record.driver ? record.status === 'failed' ? 'Review the failed attempt and arrange follow-up.' : 'Driver to collect the bag.' : 'Assign a driver in Deliveries.'}{dubaiDateKey(record.scheduledTime) < dubaiDateKey() && ' Past scheduled date — review or reschedule.'}</p>}
          {record.collectionRequest?.duplicateReason && <p>Additional request reason: {record.collectionRequest.duplicateReason}</p>}
          <Link to={`/deliveries/${record._id}`}>View collection →</Link>
        </li>)}</ul>}
        {pages > 1 && <nav className="collection-pagination" aria-label="Collection pages"><button type="button" disabled={page === 1 || loading} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {page} of {pages}</span><button type="button" disabled={page >= pages || loading} onClick={() => setPage(current => current + 1)}>Next</button></nav>}
      </section>
      <CollectionRefundTracker search={search} dateFrom={dateFrom} dateTo={dateTo} owners={people.owners} resetKey={filterResetKey} onUpdated={refreshSummary} />
    </div>
  </div>;
}
