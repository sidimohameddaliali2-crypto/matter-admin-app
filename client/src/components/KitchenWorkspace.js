import React from 'react';
import { ClipboardList, Scale, ArrowUpRight } from 'lucide-react';
import '../styles/kitchenWorkspace.css';

export function KitchenWorkspaceHeader({ counting = false, dateLabel, children }) {
  return (
    <header className={`kitchen-heading${counting ? ' kitchen-heading-counting' : ''}`}>
      <div className="kitchen-heading-title">
        <p className="kitchen-eyebrow">{counting ? 'Kitchen counting' : 'Kitchen & Menus'}</p>
        <h1>{counting ? dateLabel || 'Kitchen counting' : 'Kitchen list'}</h1>
        {!counting && dateLabel && <p className="kitchen-selected-day">{dateLabel}</p>}
        <nav className="kitchen-page-links" aria-label="Kitchen workspace">
          <a href="/kitchen-list" aria-current={!counting ? 'page' : undefined}>Kitchen List</a>
          <span aria-hidden="true">/</span>
          <a href="/kitchen-counting" aria-current={counting ? 'page' : undefined}>Kitchen Counting</a>
        </nav>
      </div>
      <div className="kitchen-heading-controls">{children}</div>
    </header>
  );
}

export function KitchenAutoScopeControl({ enabled, onChange, message }) {
  return <div className="kitchen-auto-scope">
    <label><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /> Use active menu & today automatically</label>
    <span>Remembers your preference. Uses Dubai time; you can still choose another date.</span>
    {message && <p role="status">{message}</p>}
  </div>;
}

export function KitchenEmptyState({ counting = false, hasMenu = false }) {
  return <div className="kitchen-empty">
    <span className="kitchen-empty-icon">{counting ? <Scale size={27} /> : <ClipboardList size={27} />}</span>
    <p className="kitchen-eyebrow">Ready when you are</p>
    <h2>{hasMenu ? 'Choose your delivery day.' : 'Start with the weekly menu.'}</h2>
    <p>{counting ? 'Select a menu and date to see what to cook and how much to prepare.' : 'Select a menu, then a date to review customer meals and prepare the day’s kitchen papers.'}</p>
    <span className="kitchen-empty-hint">Menu <ArrowUpRight size={14} /> Delivery date <ArrowUpRight size={14} /> {counting ? 'Production totals' : 'Kitchen preparation'}</span>
  </div>;
}
