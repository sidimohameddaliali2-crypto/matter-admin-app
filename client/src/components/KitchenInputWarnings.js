import React from 'react';

export default function KitchenInputWarnings({ entries, onShowCustomer }) {
  const incomplete = entries.filter(entry => entry.calculationStatus === 'incomplete');
  if (!incomplete.length) return null;
  return <div role="alert" className="mb-4 rounded-xl bg-amber-50 p-4 text-amber-900">
    <p className="font-semibold">{incomplete.length} customer(s) have incomplete kitchen inputs</p>
    <p className="mt-1 text-sm">Affected customers are listed below, including those hidden by your current filters. Portion weights are unavailable until their inputs are resolved. Export eligibility is checked separately for the selected delivery date.</p>
    <ul className="mt-3 space-y-3">
      {incomplete.map((entry, index) => <li key={`${entry.email || entry.customerId || 'customer'}:${index}`} className="rounded-lg border border-amber-200 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><strong>{entry.customerName || entry.email || entry.customerId || 'Unnamed customer'}</strong>
            {entry.email && <div className="text-sm break-all">Saved selection email: {entry.email}</div>}</div>
          <button type="button" onClick={() => onShowCustomer(entry)} className="rounded-lg border border-amber-400 px-3 py-2 text-sm font-semibold">Show customer</button>
        </div>
        {!entry.matterCustomerId && <p className="mt-2 text-sm font-semibold">Saved selection has no verified Matter customer ID. Verify the current website account before linking this record.</p>}
        <ul className="mt-2 list-disc pl-5 text-sm">{(entry.inputErrors?.length ? entry.inputErrors : ['Required subscription inputs could not be verified. Refresh the kitchen list to retry.']).map(reason => <li key={reason}>{reason}</li>)}</ul>
        {entry.noDeliveryDate && <p className="mt-2 text-sm">No active delivery on {entry.noDeliveryDate}; excluded from production for that date.</p>}
      </li>)}
    </ul>
  </div>;
}
