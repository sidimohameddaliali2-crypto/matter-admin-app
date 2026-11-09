import React, { useState } from 'react';
import CustomerContextDrawer, { SubscriptionList } from '../../components/customerService/CustomerContext';
import { filterParams, formatDubai, idOf, prettyStatus, ResourceState, useServiceResource } from '../../components/customerService/serviceUtils';

export default function Customers({ filters = {}, categories = [], epoch, capabilities, me, user }) {
  const [view, setView] = useState('customers');
  const [pagination, setPagination] = useState({ identity: '', page: 1 });
  const [selected, setSelected] = useState(null);
  const params = filterParams(filters);
  const identity = JSON.stringify({view,...params});
  const page = pagination.identity === identity ? pagination.page : 1;
  const records = useServiceResource('/customers', { ...params, view, page, pageSize: 50 }, epoch);
  const data = records.data;
  const rows = data?.records || [];
  const counts = data?.counts;
  const total = data?.total;
  const currentPage = data?.page || page;
  const pageSize = data?.pageSize || 50;
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const source = data?.source;
  const unmatched = view === 'unmatched';
  const changeView = next => {setView(next);setSelected(null);};
  return <section className="cs-card">
    <div className="cs-toolbar"><div><h2>{unmatched ? 'Unmatched conversations' : 'Matter customers'}</h2></div><span className="cs-badge">{typeof total === 'number' ? `${total.toLocaleString()} ${unmatched ? 'unmatched contact groups' : 'customers'} in this scope` : 'Count unavailable'}</span></div>

    <div className="cs-form-actions" role="group" aria-label="Customer directory view"><button aria-pressed={!unmatched} onClick={() => changeView('customers')}>Matter customers</button><button aria-pressed={unmatched} onClick={() => changeView('unmatched')}>Unmatched conversations</button></div>
    {counts && <details style={{marginTop:12}}><summary>Directory totals</summary><div className="cs-metrics" style={{marginTop:12}}>{[['directoryCustomers','All directory customers'],['linkedCustomers','Customers with linked conversations'],['unmatchedContacts','Unmatched contacts'],['unmatchedConversations','Unmatched conversations']].map(([key,label])=><div className="cs-metric" key={key}><strong>{Number.isFinite(counts[key]) ? counts[key].toLocaleString() : '—'}</strong><span>{label}</span></div>)}</div></details>}
    <ResourceState loading={records.loading} error={records.error}/>
    {records.error && <button onClick={records.refresh}>Retry customer directory</button>}
    {source && <details style={{margin:'12px 0'}}><summary>Source details · {prettyStatus(source.state)}</summary><div style={{marginTop:10}}><p>{source.message || (source.state === 'available' ? 'Saved Matter customer directory loaded.' : 'Matter directory source is unavailable.')}</p><p className="cs-muted">Source: {prettyStatus(source.state)} · Coverage: {prettyStatus(source.coverage)} · Observed {formatDubai(source.observedAt)}</p></div></details>}{source && source.state !== 'available' && <p className="cs-notice">{source.state === 'partial' ? source.message || 'API updated · database unavailable' : 'Saved data · source refresh unavailable.'}</p>}
    <div className="cs-table-wrap"><table><thead><tr><th>{unmatched ? 'Source contact' : 'Customer'}</th><th>{unmatched ? 'Match status' : 'Subscriptions'}</th><th>Captured issues</th><th>Context</th></tr></thead><tbody>{rows.map(customer => <tr key={customer.key || customer.customerId}><td><strong>{customer.name || 'Name not recorded'}</strong>{!customer.customerId && <p className="cs-muted">Unmatched contact</p>}<p className="cs-muted">{customer.phone || customer.email}</p></td><td>{unmatched ? <p className="cs-muted">{prettyStatus(customer.matchState || 'unmatched')}</p> : <SubscriptionList subscriptions={customer.subscriptions || []} compact/>}</td><td><p className="cs-muted">{(customer.issues || []).length} issues</p>{customer.customerId && <p className="cs-muted">{customer.issues?.length ? `Match: ${prettyStatus(customer.matchState || 'linked')}` : 'No chats in these dates'}</p>}</td><td><button onClick={() => setSelected(customer)}>{unmatched ? 'View captured chats' : 'View customer'}</button></td></tr>)}</tbody></table></div>
    {data && !rows.length && <div className="cs-empty"><h3>{unmatched ? 'No unmatched conversations in this scope' : 'No customer chats in these dates'}</h3><p>{source && !['available','partial'].includes(source.state) ? 'Source unavailable. Try again.' : 'Try All time or change the dates.'}</p></div>}
    {typeof total === 'number' && <nav className="cs-toolbar" aria-label="Customer directory pages" style={{marginTop:16}}><button disabled={records.loading || currentPage <= 1} onClick={() => setPagination({identity,page:currentPage-1})}>Previous page</button><span>Page {currentPage} of {pages} · {total ? `${(currentPage-1)*pageSize+1}–${Math.min(currentPage*pageSize,total)} of ${total.toLocaleString()}` : '0 records'}</span><button disabled={records.loading || currentPage >= pages} onClick={() => setPagination({identity,page:currentPage+1})}>Next page</button></nav>}
    {selected && <CustomerContextDrawer filters={filters} key={selected.key || selected.customerId} customerId={selected.customerId} customerName={selected.name} issues={selected.issues || []} matchState={selected.matchState} categories={categories} capabilities={capabilities} currentUserId={idOf(me?.profile?.userId || user?._id)} onClose={() => setSelected(null)}/>}
  </section>;
}
