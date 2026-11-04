import React, { memo, useMemo, useState } from 'react';

const CustomerRow = memo(({ customer, renderCustomer }) => renderCustomer(customer));

// Search belongs to this small view, not the menu editor/modal/export state.
// Keep the complete source array for downloads; limit only the rendered cards.
export default function MenuSelectionBrowser({ customers, renderCustomer }) {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);
  const index = useMemo(() => customers.map(customer => ({ customer,
    name: `${customer.firstName || ''} ${customer.lastName || ''}`.toLowerCase(),
    email: String(customer.email || '').toLowerCase(),
  })), [customers]);
  const query = search.toLowerCase();
  const matches = useMemo(() => index.filter(row => row.name.includes(query) || row.email.includes(query)), [index, query]);
  return <div>
    <input type="search" aria-label="Search customers" placeholder="Search customers..." value={search}
      onChange={event => { setSearch(event.target.value); setLimit(50); }}
      className="mb-4 w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky focus:border-transparent" />
    <div className="space-y-3">{matches.slice(0, limit).map(({ customer }) =>
      <CustomerRow key={customer._id || customer.matterCustomerId || customer.email} customer={customer} renderCustomer={renderCustomer} />)}</div>
    <div className="mt-3 flex items-center gap-3 text-sm text-matter-neutral-700" aria-live="polite">
      <span>Showing {Math.min(limit, matches.length)} of {matches.length} customers</span>
      {limit < matches.length && <button type="button" className="rounded-lg border px-3 py-2" onClick={() => setLimit(value => value + 50)}>Show 50 more customers</button>}
    </div>
  </div>;
}
