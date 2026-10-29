import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';

const identity = entry => String(entry.matterCustomerId || entry.email || entry.customerId);

// View selection only: choosing a row never changes the customer's saved meals.
export default function KitchenCustomerBrowser({ entries, controls, visibleCount, onShowMore, scope, renderCustomer }) {
  const [selectedId, setSelectedId] = useState(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const returnFocus = useRef(null);
  useEffect(() => { setSelectedId(null); setMobileDetail(false); }, [scope]);
  const selected = entries.find(entry => identity(entry) === selectedId) || entries[0];
  const back = () => { setMobileDetail(false); requestAnimationFrame(() => returnFocus.current?.focus()); };
  return <div className={`kitchen-browser${mobileDetail && selected ? ' kitchen-browser-detail-open' : ''}`}>
    <aside className="kitchen-browser-master" aria-label="Customer selections">
      <div className="kitchen-browser-filters">{controls}</div>
      <div className="kitchen-customer-index">
        {entries.slice(0, visibleCount).map(entry => <button key={identity(entry)} type="button"
          className="kitchen-customer-row" aria-pressed={selected && identity(selected) === identity(entry)}
          onClick={event => { returnFocus.current = event.currentTarget; setSelectedId(identity(entry)); setMobileDetail(true); }}>
          <strong>{entry.customerName || entry.email || 'Unknown customer'}</strong>
          <b title={(entry.inputErrors || []).join(' ')}>{entry.kitchenProductionExcluded ? 'Not scheduled' : entry.calculationStatus === 'incomplete' ? 'Unavailable' : `${Number(entry.totalWeight || 0).toLocaleString()} g`}</b>
          <span>{entry.planName || 'No plan'} · {entry.mealsPerDay ?? '—'} meals/day</span>
          <span className="kitchen-row-marks">{entry.missingSelection && <em>Missing</em>}{entry.needsAttention && <em>Review</em>}{entry.kitchenProductionExcluded && <em>Not scheduled for this date</em>}</span>
          <ChevronRight size={15} className="kitchen-row-arrow" />
        </button>)}
        {!entries.length && <p className="kitchen-index-footer">No customers match the current filters.</p>}
        <div className="kitchen-index-footer">Showing {Math.min(entries.length, visibleCount)} of {entries.length} customers</div>
        {entries.length > visibleCount && <button type="button" className="kitchen-show-more" onClick={onShowMore}>Show 50 more customers</button>}
      </div>
    </aside>
    <section className="kitchen-browser-detail" aria-label="Selected customer">
      {selected ? <>
        <button type="button" className="kitchen-mobile-back" onClick={back}><ArrowLeft size={18} /> Back to customers</button>
        {renderCustomer(selected)}
      </> : <div className="kitchen-detail-placeholder">Select a customer to review their meals, weights and kitchen notes.</div>}
    </section>
  </div>;
}
