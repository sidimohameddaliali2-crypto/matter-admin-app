import React, { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { EXCLUSION_LIST } from '../../constants/exclusionList';
import { Action } from './components';
import { toTitleCase } from '../../utils/textFormat';

export default function ComponentExclusions({ values, onChange, componentName }) {
  const [input, setInput] = useState('');
  const optionsId = useId();
  const add = () => {
    const added = input.split(',').map(value => value.trim()).filter(Boolean);
    const seen = new Set(values.map(value => value.toLowerCase()));
    onChange([...values, ...added.filter(value => { if (seen.has(value.toLowerCase())) return false; seen.add(value.toLowerCase()); return true; })]);
    setInput('');
  };
  return <fieldset className="av2-exclusions-editor"><legend>Exclusions / dietary flags</legend>
    <small>Choose from the list or add a custom exclusion. Supports ten or more exclusions per component.</small>
    <div className="av2-exclusion-chips">{values.filter(Boolean).map((value, index) => <span key={`${value}-${index}`}>{toTitleCase(value)}<button type="button" aria-label={`Remove exclusion ${toTitleCase(value)}`} onClick={() => onChange(values.filter((_, i) => i !== index))}><X size={12}/></button></span>)}{!values.length && <small>No flags recorded</small>}</div>
    <div className="av2-add-exclusion"><input aria-label={`Add exclusion for ${componentName}`} list={optionsId} placeholder="Choose or type an exclusion..." value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}/><Action icon={Plus} disabled={!input.trim()} onClick={add}>Add exclusion</Action></div>
    <datalist id={optionsId}>{[...new Set(EXCLUSION_LIST.map(toTitleCase))].map(value => <option key={value} value={value}/>)}</datalist>
  </fieldset>;
}
