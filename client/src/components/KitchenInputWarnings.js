import React from 'react';
import { getDateKey } from '../lib/kitchenData';

export default function KitchenInputWarnings({ entries, selectedDate, onShowCustomer }) {
  const incomplete = entries.filter(entry => {
    if (entry.calculationStatus !== 'incomplete' || entry.kitchenProductionExcluded) return false;
    if (!selectedDate) return true;
    if (entry.noDeliveryDate === selectedDate) return false;
    if ((entry.skippedDays || []).some(day => getDateKey(day.date || day) === selectedDate)) return false;
    return (entry.selectedMeals || []).some(meal => getDateKey(meal.date) === selectedDate)
      || (entry.missingSelection && entry.missingSelectionDate === selectedDate);
  });
  if (!incomplete.length) return null;
  return <div role="alert" className="mb-4 rounded-xl bg-amber-50 p-4 text-amber-900">
    <p className="font-semibold">{incomplete.length} customer(s) have incomplete kitchen inputs</p>
    <p className="mt-1 text-sm">These customers have unresolved inputs for the selected kitchen date, including customers hidden by your current filters.</p>
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
