import React, { useState } from 'react';
import KitchenSnackRuleEditor from './KitchenSnackRuleEditor';

// Preparation can be incomplete when all snack options are blocked. Keep a
// rule editor reachable even when the production customer list cannot load.
export default function KitchenSnackRuleLookup({ menuId, date, onSaved, onReplaced }) {
  const [input, setInput] = useState(''), [customerId, setCustomerId] = useState('');
  return <details className="kitchen-advanced">
    <summary>Manage snack rules by Matter customer ID</summary>
    <form className="flex gap-2 p-3" onSubmit={event => { event.preventDefault(); if (/^[1-9]\d*$/.test(input.trim())) setCustomerId(input.trim()); }}>
      <input aria-label="Matter customer ID for snack rules" value={input} onChange={event => setInput(event.target.value)} placeholder="Matter customer ID" inputMode="numeric" className="rounded-lg border p-2" />
      <button type="submit" className="kitchen-button-secondary" disabled={!/^[1-9]\d*$/.test(input.trim())}>Find snack rules</button>
    </form>
    {customerId && <div><p className="px-5 text-sm">Matter customer ID: {customerId}</p><KitchenSnackRuleEditor key={customerId} entry={{ matterCustomerId: customerId }} menuId={menuId} date={date} onSaved={onSaved} onReplaced={onReplaced} /></div>}
  </details>;
}
