import React, { useMemo, useState } from 'react';
import CustomerContextDrawer from '../../components/customerService/CustomerContext';
import { categoryLabels, filterParams, idOf, matchesIssue, prettyStatus, ResourceState, useServiceResource } from '../../components/customerService/serviceUtils';

export default function Customers({ filters, categories, epoch, capabilities, me, user }) {
  const records = useServiceResource('/issues', filterParams(filters), epoch);
  const [selected, setSelected] = useState(null);
  const customers = useMemo(() => {
    const grouped = new Map();
    (records.data?.issues || []).filter(issue => matchesIssue(issue, filters)).forEach(issue => {
      // Unlinked conversations remain separate; similar names are never merged.
      const key = issue.customerId || `unlinked:${issue.conversationId || idOf(issue)}`;
      if (!grouped.has(key)) grouped.set(key, { key, customerId: issue.customerId, name: issue.customerName || 'Name not recorded', issues: [] });
      grouped.get(key).issues.push(issue);
    });
    return [...grouped.values()];
  }, [records.data, filters]);
  return <section className="cs-card"><div className="cs-toolbar"><div><p className="cs-eyebrow">Customer context</p><h2>Customers behind the conversations</h2></div><span className="cs-badge">{records.data ? `${customers.length} in this scope` : 'Loading'}</span></div><p className="cs-muted">Matter customer context opens on demand. Unlinked conversations stay visible and are never matched by a similar name.</p><ResourceState loading={records.loading} error={records.error}/><div className="cs-table-wrap"><table><thead><tr><th>Customer</th><th>Issue topics</th><th>Outcomes</th><th>Context</th></tr></thead><tbody>{customers.map(customer => <tr key={customer.key}><td><strong>{customer.name}</strong><p className="cs-muted">{customer.customerId || 'No linked Matter ID'}</p></td><td>{categoryLabels([...new Set(customer.issues.flatMap(issue => issue.categoryIds || []))], categories)}<p className="cs-muted">{customer.issues.length} unique issues</p></td><td>{[...new Set(customer.issues.map(issue => issue.outcome || 'unknown'))].map(outcome => <span className="cs-badge" key={outcome} style={{ marginRight: 4 }}>{prettyStatus(outcome)}</span>)}</td><td><button onClick={() => setSelected(customer)}>View customer</button></td></tr>)}</tbody></table></div>{records.data && !customers.length && <div className="cs-empty"><h3>No customers in this scope</h3><p>Adjust the filters or capture an authorized dated conversation export.</p></div>}{selected && <CustomerContextDrawer customerId={selected.customerId} customerName={selected.name} issues={selected.issues} categories={categories} capabilities={capabilities} currentUserId={idOf(me?.profile?.userId || user?._id)} onClose={() => setSelected(null)}/>}</section>;
}
