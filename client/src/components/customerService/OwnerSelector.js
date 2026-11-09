import React from 'react';
import { displayName, idOf } from './serviceUtils';

export default function OwnerSelector({ value, onChange, owners = [], capabilities = {}, currentUserId, disabled = false }) {
  const own = owners.find(owner => idOf(owner.userId || owner) === String(currentUserId));
  const available = capabilities.assignRequests ? owners : [];
  return <label>Owner<select aria-label="Action owner" value={value || ''} onChange={event => onChange(event.target.value)} disabled={disabled||!capabilities.assignRequests}><option value="">{capabilities.assignRequests ? 'Unassigned · supervisor to triage' : 'Ask supervisor to assign someone else'}</option>{value && !available.some(owner=>idOf(owner.userId||owner)===String(value)) && <option value={value}>Recorded owner · not in current staff directory</option>}{available.map(owner => <option value={idOf(owner.userId || owner)} key={idOf(owner.userId || owner)}>{displayName(owner)}{idOf(owner.userId || owner) === String(currentUserId) ? ' (me)' : ''}{capabilities.assignRequests && owner.openActions != null ? ` · ${owner.openActions} open actions` : ''}</option>)}</select></label>;
}
