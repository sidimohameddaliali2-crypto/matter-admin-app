import React from 'react';
import { selectionComponentDetails } from '../utils/selectionComponentDetails';

export default function SelectionStatusTags({ meal }) {
  const autoAssigned = meal?.isAutoAssigned === true;
  // A conflict alone is not consent. Use saved customer preference/kept-side
  // evidence, including legacy kept sides, and never label auto assignments as acknowledged.
  const acknowledged = !autoAssigned && (meal?.preferenceConflict?.length > 0
    || selectionComponentDetails(meal).some(({ action }) => action === 'kept'));
  return <>
    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${autoAssigned ? 'bg-matter-neutral-200 text-matter-neutral-800' : 'bg-blue-100 text-blue-700'}`}>
      {autoAssigned ? 'Auto assigned' : 'Selected'}
    </span>
    {acknowledged && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800">
      Exclusion acknowledged
    </span>}
  </>;
}
