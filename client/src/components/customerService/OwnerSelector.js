import React from 'react';
import { displayName, idOf } from './serviceUtils';

export default function OwnerSelector({ value, onChange, owners = [], capabilities = {}, currentUserId, disabled = false }) {
  const own = owners.find(owner => idOf(owner.userId || owner) === String(currentUserId));
  const available = capabilities.supervise ? owners : own ? [own] : currentUserId && capabilities.workActions ? [{ userId: currentUserId, displayName: 'Me' }] : [];
  return <label>Owner<select aria-label="Action owner" value={value || ''} onChange={event => onChange(event.target.value)} disabled={disabled}><option value="">{capabilities.supervise ? 'Unassigned · supervisor to triage' : 'Ask supervisor to assign someone else'}</option>{available.map(owner => <option value={idOf(owner.userId || owner)} key={idOf(owner.userId || owner)}>{displayName(owner)}{idOf(owner.userId || owner) === String(currentUserId) ? ' (me)' : ''}{capabilities.supervise && owner.openActions != null ? ` · ${owner.openActions} open actions` : ''}</option>)}</select><span className="cs-owner-note">{capabilities.supervise ? 'Only eligible staff are listed. Reassignment is recorded in history.' : 'Own this follow-up or leave an explicit request for the supervisor. Review assignment and action ownership are separate.'}</span></label>;
}
