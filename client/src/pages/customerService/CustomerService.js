import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RefreshCw, Search } from 'lucide-react';
import api from '../../utils/api';
import Summary from './Summary';
import Reporting from './Reporting';
import Problems from './Problems';
import Customers from './Customers';
import CustomerChats from './CustomerChats';
import CustomerReviews from './CustomerReviews';
import { updateServiceFilterSearch, dubaiToday, serviceFiltersFromSearch, serviceFilterSearch, displayName, errorMessage, idOf, servicePath, unpack, useServiceResource } from '../../components/customerService/serviceUtils';
import './customerService.css';

const tabs = [['chats', 'Inbox'], ['problems', 'Follow-ups'], ['customers', 'Customers'], ['reviews', 'Reviews'], ['summary', 'Summary'], ['reporting', 'Reporting']];

function SupervisorSetup({ onConfigured }) {
  const team = useServiceResource('/team');
  const [selected, setSelected] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const candidates = team.data?.candidates || team.data?.users || [];
  async function submit(event) {
    event.preventDefault(); if (busy || !selected) return;
    setBusy(true); setError('');
    try {
      await api.post(`${servicePath}/setup`, { userId: selected, displayName: label.trim() || displayName(candidates.find(candidate => idOf(candidate) === selected)), enabled: true });
      onConfigured();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <section className="cs-card cs-setup"><p className="cs-eyebrow">Workflow setup</p><h2>Set up a supervisor</h2><p>Choose an existing staff account to manage the review pool and follow-ups. This grants customer service supervision.</p>
    {(error || team.error) && <div className="cs-alert" role="alert">{error || team.error}</div>}
    <form onSubmit={submit}><label>Existing staff account<select aria-label="Supervisor account" value={selected} onChange={event => setSelected(event.target.value)} required><option value="">Select an account</option>{candidates.map(candidate => <option key={idOf(candidate)} value={idOf(candidate)}>{displayName(candidate)}</option>)}</select></label><label>Display name (optional)<input value={label} onChange={event => setLabel(event.target.value)} maxLength={100} /></label><button className="cs-primary" disabled={busy || !selected || team.loading} type="submit">{busy ? 'Setting up…' : 'Set up supervisor'}</button></form>
    <p className="cs-muted">No accounts are created and no customer messages are sent.</p></section>;
}

export default function CustomerService() {
  const user = useSelector(state => state.auth?.user);
  const identity = idOf(user);
  // An explicit account change discards the prior account's in-memory views
  // and drafts. A transient request failure does not change this boundary.
  return identity ? <CustomerServiceWorkspace key={identity} user={user} /> : <section className="cs-card"><p role="status">Checking staff sign-in…</p></section>;
}

function CustomerServiceWorkspace({ user }) {
  const location = useLocation();
  const navigate = useNavigate();
  const selectedTab = location.pathname.split('/')[2] || 'chats';
  const activeTab = tabs.some(([key]) => key === selectedTab) ? selectedTab : 'chats';
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const [filters, setFilters] = useState(() => serviceFiltersFromSearch(location.search));
  const accessRequest = useRef(null);
  const loadMe = useCallback(async () => {
    accessRequest.current?.abort();
    const request = new AbortController(); accessRequest.current = request;
    setLoading(true); setError('');
    try {
      const response = await api.get(`${servicePath}/me`, { signal: request.signal });
      if (!request.signal.aborted) setMe(unpack(response));
    } catch (failure) { if (!request.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { loadMe(); return () => accessRequest.current?.abort(); }, [loadMe]);
  const capabilities = me?.capabilities || {};
  const allowed = capabilities.review || capabilities.supervise || capabilities.workActions;
  const dictionary = useServiceResource(allowed ? '/categories' : null, {}, epoch);
  const categories = Array.isArray(dictionary.data) ? dictionary.data : dictionary.data?.categories || [];
  const refresh = () => setEpoch(value => value + 1);
  useEffect(() => { setFilters(serviceFiltersFromSearch(location.search)); }, [location.search]);
  const changeFilters = next => { setFilters(next); navigate(`${location.pathname}${updateServiceFilterSearch(next,location.search)}`, {replace:true}); };
  const updateFilter = (key, value) => changeFilters({ ...filters, [key]: value });
  const today = dubaiToday();
  const props = { me, user, capabilities, categories, filters, epoch, onRefresh: refresh, onFiltersChange: changeFilters };
  return <div className={`matter-cs ${activeTab==='chats'?'cs-compact-inbox':''} ${user.localPreview?'cs-local-read-preview':''}`}>
    {user.localPreview&&<p className="cs-local-preview-note" role="status">Local preview · live records · view only</p>}
    {activeTab!=='chats'&&<header className={`cs-header ${activeTab==='chats'?'cs-compact-header':''}`}>
      <div className="cs-heading-row"><div className="cs-brand">Matter<span />Customer service</div><nav aria-label="Customer service pages">{tabs.map(([key, label]) => <Link key={key} to={`${servicePath}/${key}${serviceFilterSearch(filters)}`} className={key === activeTab ? 'active' : ''} aria-current={key === activeTab ? 'page' : undefined}>{label}</Link>)}</nav></div>
      <div className="cs-filter-row"><div className="cs-chip-row cs-date-shortcuts" role="group" aria-label="Date range"><button aria-pressed={filters.from === today && filters.to === today} onClick={() => changeFilters({...filters,from:today,to:today})}>Today</button><button aria-pressed={!filters.from && !filters.to} onClick={() => changeFilters({...filters,from:'',to:''})}>All time</button></div><div className="cs-period"><label>From<input type="date" aria-label="From date in Dubai" value={filters.from} max={filters.to || undefined} onChange={event => updateFilter('from', event.target.value)} /></label><label>To<input type="date" aria-label="To date in Dubai" value={filters.to} min={filters.from || undefined} onChange={event => updateFilter('to', event.target.value)} /></label></div><label className="cs-search"><Search size={17} aria-hidden="true"/><input aria-label="Search customer service" placeholder="Search customers or issues" value={filters.search} onChange={event => updateFilter('search', event.target.value)} /></label><select aria-label="Review category filter" value={filters.categoryId} onChange={event => updateFilter('categoryId', event.target.value)}><option value="">All review categories</option>{categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select><div className="cs-person"><strong>{me?.profile?.displayName || displayName(user)}</strong><span>{capabilities.supervise ? 'Supervisor' : capabilities.review ? 'Reviewer' : capabilities.setup ? 'Setup administrator' : 'Staff'} · Dubai time</span></div><button className="cs-icon-button" aria-label="Refresh customer service" title="Refresh saved information" onClick={() => { if (!me) loadMe(); else refresh(); }}><RefreshCw size={18}/></button></div>
    </header>}
    {loading && <section className="cs-card"><p role="status">Checking customer service access…</p></section>}
    {error && <section className="cs-card"><div className="cs-alert" role="alert">{error}</div><button onClick={loadMe}>Try again</button></section>}
    {!loading && !error && !allowed && !capabilities.setup && <section className="cs-card cs-empty"><h2>Customer service access is not configured</h2><p>Ask your supervisor for access.</p></section>}
    {!loading && !error && !allowed && capabilities.setup && <SupervisorSetup onConfigured={loadMe} />}
    {!loading && !error && allowed && <>{dictionary.error && <div className="cs-alert" role="alert">Category definitions unavailable: {dictionary.error}</div>}{activeTab === 'reporting' && <Reporting {...props} />}{activeTab === 'summary' && <Summary {...props} />}{activeTab === 'problems' && <Problems {...props} />}{activeTab === 'customers' && <Customers {...props} />}{activeTab === 'chats' && <CustomerChats {...props} navigation={<nav aria-label="Customer service pages">{tabs.map(([key,label])=><Link key={key} to={servicePath+'/'+key+serviceFilterSearch(filters)}>{label}</Link>)}</nav>} />}{activeTab === 'reviews' && <CustomerReviews {...props} />}</>}
    {activeTab!=='chats'&&<footer className="cs-page-footer">Dubai time · Staff inbox</footer>}
  </div>;
}
