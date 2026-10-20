import React, { useMemo, useState } from 'react';

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const toDateKey = (d) => {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fromKey = (key) => {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const monthLabel = (date) => date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

/**
 * Pure, presentational month-grid calendar. Renders amber dots for `kind:
 * 'skip'` markers and green dots for `kind: 'resume'` markers, so a customer
 * can see every day they're pausing and every day their deliveries resume on
 * in one place, however many dates are involved — no per-date modal.
 * Owns only its own "which month is showing" state; everything about what's
 * paused/resumed/selected lives in the parent (SkipPauseCalendarModal).
 */
const PauseCalendarGrid = ({ initialMonth, markers = [], selectedDate = null, onSelectDate, minSelectableDate = null }) => {
  const [viewMonth, setViewMonth] = useState(() => {
    const anchor = initialMonth ? fromKey(initialMonth) : new Date();
    return new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  });

  const markersByDate = useMemo(() => {
    const map = new Map();
    markers.forEach((m) => {
      const key = toDateKey(m.date);
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m.kind);
    });
    return map;
  }, [markers]);

  const cells = useMemo(() => {
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out = [];
    for (let i = 0; i < firstWeekday; i += 1) out.push(null);
    for (let day = 1; day <= daysInMonth; day += 1) out.push(toDateKey(new Date(year, month, day)));
    return out;
  }, [viewMonth]);

  const todayKey = toDateKey(new Date());

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
          style={{ fontSize: 16, padding: '2px 10px' }}
          aria-label="Previous month"
        >
          ‹
        </button>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{monthLabel(viewMonth)}</div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
          style={{ fontSize: 16, padding: '2px 10px' }}
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {WEEKDAY_LABELS.map((w, i) => (
          <div key={i} style={{ textAlign: 'center', fontSize: 10.5, color: 'var(--color-neutral-500)', fontWeight: 600 }}>{w}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((key, i) => {
          if (!key) return <div key={i} />;
          const kinds = markersByDate.get(key) || [];
          const isSkip = kinds.includes('skip');
          const isResume = kinds.includes('resume');
          const isSelected = key === selectedDate;
          const isPast = key < todayKey;
          const isBelowMin = minSelectableDate ? key < minSelectableDate : false;
          const selectable = !!onSelectDate && !isPast && !isBelowMin;
          return (
            <button
              key={i}
              type="button"
              disabled={!selectable}
              onClick={() => selectable && onSelectDate(key)}
              style={{
                position: 'relative',
                height: 34,
                borderRadius: 10,
                border: isSelected ? '2px solid var(--color-accent)' : '1px solid transparent',
                background: isSelected ? 'var(--color-accent-100)' : 'transparent',
                color: isPast || isBelowMin ? 'var(--color-neutral-400)' : 'var(--color-text)',
                cursor: selectable ? 'pointer' : 'default',
                fontSize: 12.5,
                fontFamily: 'inherit',
              }}
              title={isSkip ? 'Skipped (no delivery)' : isResume ? 'Resumes here' : undefined}
            >
              {Number(key.slice(8, 10))}
              <div style={{ position: 'absolute', bottom: 3, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 2 }}>
                {isSkip ? <span style={{ width: 5, height: 5, borderRadius: 999, background: '#D97706', display: 'inline-block' }} /> : null}
                {isResume ? <span style={{ width: 5, height: 5, borderRadius: 999, background: '#16A34A', display: 'inline-block' }} /> : null}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 11.5, color: 'var(--color-neutral-600)' }}>
        <span><span style={{ width: 7, height: 7, borderRadius: 999, background: '#D97706', display: 'inline-block', marginRight: 4 }} />Paused</span>
        <span><span style={{ width: 7, height: 7, borderRadius: 999, background: '#16A34A', display: 'inline-block', marginRight: 4 }} />Resumes</span>
      </div>
    </div>
  );
};

export default PauseCalendarGrid;
export { toDateKey };
