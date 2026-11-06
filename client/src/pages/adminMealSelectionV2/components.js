import React, { useEffect, useRef } from 'react';
import { Search, X, Info } from 'lucide-react';
import { Button } from '../../components/ui/button';
export function Action({
  children,
  primary,
  icon: Icon,
  ...props
}) {
  return <Button variant="outline" size="sm" className={`av2-action ${primary ? 'av2-primary' : ''}`} {...props}>{Icon && <Icon size={14} />}{children}</Button>;
}
export function Badge({
  children,
  tone = 'grey'
}) {
  return <span className={`av2-badge av2-${tone}`}>{children}</span>;
}
export function Allergens({
  values
}) {
  return values === null ? <Badge tone="amber">Allergens not set</Badge> : values?.length ? <span className="av2-badges">{values.map(v => <Badge tone="amber" key={v}>{v}</Badge>)}</span> : <span className="av2-muted">None</span>;
}
export function Panel({
  title,
  children,
  actions,
  className = ''
}) {
  return <section className={`av2-panel ${className}`}>{title && <div className="av2-heading"><h2>{title}</h2>{actions}</div>}{children}</section>;
}
export function Tabs({
  values,
  value,
  onChange
}) {
  return <div className="av2-tabs" role="tablist">{values.map(v => <button key={v} type="button" role="tab" aria-selected={v === value} className={v === value ? 'active' : ''} onClick={() => onChange(v)}>{v}</button>)}</div>;
}
export function SearchBox({
  value,
  onChange,
  placeholder
}) {
  return <label className="av2-search"><Search size={15} /><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} /></label>;
}
export function Select({
  label,
  values,
  value,
  onChange
}) {
  return <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}><option value="">{label}</option>{values.map(v => <option key={v}>{v}</option>)}</select>;
}
export function Notice({
  children,
  tone = 'blue'
}) {
  return <div className={`av2-notice av2-${tone}`}><Info size={17} /><div>{children}</div></div>;
}
export function DataTable({
  headers,
  rows,
  empty = 'No results match these filters.'
}) {
  return <div className="av2-table-scroll"><table><thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}{!rows.length && <tr><td colSpan={headers.length} className="av2-empty">{empty}</td></tr>}</tbody></table></div>;
}
export function Modal({
  title,
  children,
  onClose,
  footer
}) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const onKey = e => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key !== 'Tab') return;
      const items = ref.current?.querySelectorAll('button:not(:disabled), input, select, a[href], [tabindex="0"]');
      if (!items?.length) {
        e.preventDefault();
        return;
      }
      const first = items[0],
        last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return <div className="av2-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="av2-modal"><div className="av2-heading"><h2>{title}</h2><button className="av2-icon" aria-label="Close dialog" onClick={onClose}><X size={19} /></button></div>{children}{footer && <footer>{footer}</footer>}</section></div>;
}
export function downloadCsv(name, headers, rows) {
  const csv = [headers, ...rows].map(row => row.map(value => {
    const s = String(value ?? '');
    return `"${(/^[=+@\-]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {
    type: 'text/csv;charset=utf-8'
  }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
