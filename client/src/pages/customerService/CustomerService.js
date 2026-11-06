import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { ArrowUpRight, RefreshCw, Search } from 'lucide-react';
import api from '../../utils/api';
import Summary from './Summary';
import Problems from './Problems';
import Customers from './Customers';
import CustomerChats from './CustomerChats';
import { displayName, errorMessage, idOf, servicePath, unpack, useServiceResource } from '../../components/customerService/serviceUtils';
import './customerService.css';

const tabs = [['summary', 'Summary'], ['problems', 'Problems'], ['customers', 'Customers'], ['chats', 'Customer chats']];

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
  const location = useLocation();
  const selectedTab = location.pathname.split('/')[2] || 'summary';
  const activeTab = tabs.some(([key]) => key === selectedTab) ? selectedTab : 'summary';
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const [filters, setFilters] = useState({ from: '', to: '', categoryId: '', search: '' });
  const loadMe = useCallback(async () => {
    setLoading(true); setError('');
    try { setMe(unpack(await api.get(`${servicePath}/me`))); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadMe(); }, [loadMe]);
  const capabilities = me?.capabilities || {};
  const allowed = capabilities.review || capabilities.supervise || capabilities.workActions;
  const dictionary = useServiceResource(allowed ? '/categories' : null, {}, epoch);
  const categories = Array.isArray(dictionary.data) ? dictionary.data : dictionary.data?.categories || [];
  const refresh = () => setEpoch(value => value + 1);
  const updateFilter = (key, value) => setFilters(previous => ({ ...previous, [key]: value }));
  const props = { me, user, capabilities, categories, filters, epoch, onRefresh: refresh };
  return <div className="matter-cs">
    <header className="cs-header">
      <div className="cs-heading-row"><div className="cs-brand">Matter<span />Customer service</div><nav aria-label="Customer service pages">{tabs.map(([key, label]) => <Link key={key} to={`${servicePath}/${key}`} className={key === activeTab ? 'active' : ''} aria-current={key === activeTab ? 'page' : undefined}>{label}</Link>)}</nav></div>
      <div className="cs-filter-row"><div className="cs-period"><label>From<input type="date" aria-label="From date in Dubai" value={filters.from} max={filters.to || undefined} onChange={event => updateFilter('from', event.target.value)} /></label><label>To<input type="date" aria-label="To date in Dubai" value={filters.to} min={filters.from || undefined} onChange={event => updateFilter('to', event.target.value)} /></label></div><label className="cs-search"><Search size={17} aria-hidden="true"/><input aria-label="Search customer service" placeholder="Search customers or issues" value={filters.search} onChange={event => updateFilter('search', event.target.value)} /></label><select aria-label="Issue category filter" value={filters.categoryId} onChange={event => updateFilter('categoryId', event.target.value)}><option value="">All categories</option>{categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select><div className="cs-person"><strong>{me?.profile?.displayName || displayName(user)}</strong><span>{capabilities.supervise ? 'Supervisor' : capabilities.review ? 'Reviewer' : capabilities.setup ? 'Setup administrator' : 'Staff'} · Dubai time</span></div><button className="cs-icon-button" aria-label="Refresh customer service" title="Refresh saved information" onClick={() => { if (!me) loadMe(); else refresh(); }}><RefreshCw size={18}/></button></div>
      <div className="cs-header-note"><span>Reviews and internal follow-ups</span><span>Source inbox remains in Gallabox <ArrowUpRight size={13} aria-hidden="true"/></span></div>
    </header>
    {loading && <section className="cs-card"><p role="status">Checking customer service access…</p></section>}
    {error && <section className="cs-card"><div className="cs-alert" role="alert">{error}</div><button onClick={loadMe}>Try again</button></section>}
    {!loading && !error && !allowed && !capabilities.setup && <section className="cs-card cs-empty"><h2>Customer service access is not configured</h2><p>Your existing app role does not grant access to this workflow. A customer service supervisor can configure reviewer membership.</p></section>}
    {!loading && !error && !allowed && capabilities.setup && <SupervisorSetup onConfigured={loadMe} />}
    {!loading && !error && allowed && <>{dictionary.error && <div className="cs-alert" role="alert">Category definitions unavailable: {dictionary.error}</div>}{activeTab === 'summary' && <Summary {...props} />}{activeTab === 'problems' && <Problems {...props} />}{activeTab === 'customers' && <Customers {...props} />}{activeTab === 'chats' && <CustomerChats {...props} />}</>}
    <footer className="cs-page-footer">All times Asia/Dubai · Saving here records internal work and sends no customer message.</footer>
  </div>;
}
