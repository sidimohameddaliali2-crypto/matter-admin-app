import React from 'react';
import { selectionComponentDetails } from '../utils/selectionComponentDetails';

export default function SelectionComponentTags({ meal }) {
  return selectionComponentDetails(meal).map(({ action, component, label, detail }) => (
    <span key={`${action}-${component}`} className={`text-xs font-bold px-2 py-0.5 rounded-full ${action === 'kept' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {label}: {detail}
    </span>
  ));
}
