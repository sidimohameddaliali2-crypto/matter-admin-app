import React, { useEffect, useRef, useState } from 'react';
import { Search, Check, X } from 'lucide-react';
import { staffName, dispatchZoneCounts } from '../../utils/dispatcher';
export function DispatcherDialog({
  title,
  onClose,
  busy = false,
  children
}) {
  const ref = useRef(null),
    close = useRef(onClose),
    locked = useRef(busy);
  close.current = onClose;
  locked.current = busy;
  useEffect(() => {
    const previous = document.activeElement,
      overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector('button,input')?.focus();
    const key = e => {
      if (e.key === 'Escape' && !locked.current) close.current();
      if (e.key === 'Tab') {
        const nodes = [...ref.current.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(n => !n.disabled && n.getAttribute('aria-hidden') !== 'true');
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return <div className="dp-scrim" onMouseDown={e => {
    if (e.target === e.currentTarget && !busy) onClose();
  }}><section className="dp-dialog" ref={ref} role="dialog" aria-modal="true" aria-label={title}><header><div><p className="dp-eyebrow">MATTER / DISPATCHER</p><h2>{title}</h2></div><button aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={20} /></button></header><div className="dp-dialog-body">{children}</div></section></div>;
}
export default function DispatcherFilters({
  filters,
  zones,
  drivers,
  emirates,
  deliveries = [], date, searchTerm = '', collections = false, unassigned = false,
  onApply,
  onClose
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, [...v]]))),
    [search, setSearch] = useState({
      zones: '',
      drivers: ''
    });
  const toggle = (key, value) => setDraft(d => ({
    ...d,
    [key]: d[key].includes(value) ? d[key].filter(v => v !== value) : [...d[key], value]
  }));
  const zoneCounts = dispatchZoneCounts(deliveries,{date,search:searchTerm,filters:draft,collections,unassigned});
  const groups = [['zones', 'Zones', zones.map(z => ({
    value: z,
    label: z,
    detail: `${zoneCounts[z] || 0} ${unassigned ? 'unassigned' : 'available'}`
  }))], ['drivers', 'Drivers', [{
    value: 'unassigned',
    label: 'Unassigned'
  }, ...drivers.map(d => ({
    value: String(d._id),
    label: staffName(d),
    detail: d.profile?.vehicleType || d.email || ''
  }))]], ['hours', 'Delivery start hour', Array.from({
    length: 24
  }, (_, h) => ({
    value: String(h),
    label: String(h).padStart(2, '0') + ':00'
  }))], ['emirates', 'Emirates', emirates.map(e => ({
    value: e,
    label: e
  }))]];
  const total = Object.values(draft).reduce((n, a) => n + a.length, 0);
  return <DispatcherDialog title="Delivery filters" onClose={onClose}><p>Choose more than one zone, driver, hour or emirate.</p>{groups.map(([key, label, options]) => {
      const searchable = key === 'zones' || key === 'drivers',
        matches = options.filter(o => (o.label + ' ' + (o.detail || '')).toLowerCase().includes((search[key] || '').trim().toLowerCase()));
      return <fieldset className="dp-filter-group" key={key}><legend>{label}<small>{draft[key].length} selected</small></legend>{searchable && <label className="dp-search"><Search size={17} /><input aria-label={`Search ${key}`} placeholder={`Search ${key}…`} value={search[key]} onChange={e => setSearch(s => ({
            ...s,
            [key]: e.target.value
          }))} /></label>}<div className={searchable ? 'dp-filter-list' : 'dp-chips'} role="group" aria-label={`${label} options`} tabIndex={searchable ? 0 : undefined}>{matches.map(o => <button type="button" key={o.value} aria-label={key === 'zones' ? o.label : undefined} aria-describedby={key === 'zones' ? `dp-zone-count-${encodeURIComponent(o.value)}` : undefined} aria-pressed={draft[key].includes(o.value)} onClick={() => toggle(key, o.value)}><span>{o.label}{o.detail && <small id={key === 'zones' ? `dp-zone-count-${encodeURIComponent(o.value)}` : undefined}>{o.detail}</small>}</span>{searchable && <i>{draft[key].includes(o.value) && <Check size={15} />}</i>}</button>)}{!matches.length && <p className="dp-empty">No {key} match your search.</p>}</div>{searchable && <small className="dp-help">{matches.length} of {options.length} {key} · scroll for more</small>}</fieldset>;
    })}<footer className="dp-dialog-footer"><p>{total ? `${total} filters selected · selections stay when you search` : 'No filters selected · show all deliveries'}</p><div className="dp-actions"><button onClick={() => {
          setDraft({
            zones: [],
            drivers: [],
            hours: [],
            emirates: []
          });
          setSearch({
            zones: '',
            drivers: ''
          });
        }}>Clear all</button><button className="primary" onClick={() => onApply(draft)}>Apply filters</button></div></footer></DispatcherDialog>;
}
