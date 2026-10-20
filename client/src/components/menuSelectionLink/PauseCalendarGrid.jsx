import React, { useEffect, useMemo, useState } from 'react';

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
 * Pure, presentational month-grid calendar. Marks a `kind: 'skip'` date with
 * a filled red circle and a `kind: 'resume'` date with a filled green
 * circle, so a customer can see every day they're pausing and every day
 * their deliveries resume on in one place, however many dates are involved —
 * no per-date modal. Owns its own "which month is showing" state so a parent
 * re-render never resets navigation — EXCEPT when `jumpToMonth` changes (see
 * below), which is how the parent steers the view to wherever it's relevant
 * right now (e.g. a resume date that's in a different month than the skip
 * date sitting right next to it in the list).
 */
const PauseCalendarGrid = ({ initialMonth, markers = [], selectedDate = null, onSelectDate, minSelectableDate = null, jumpToMonth = null, blockedDates = [], weekendEnabled = true }) => {
  const [viewMonth, setViewMonth] = useState(() => {
    const anchor = initialMonth ? fromKey(initialMonth) : new Date();
    return new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  });

  // A skip date and its resume date are often in
  // different months (resume dates are placed after the subscription's
  // cycle end, which can be weeks away) — without this, picking a new row to
  // edit left its current/suggested resume date off-screen in a month the
  // customer had to guess to navigate to, which read as "the resume date
  // isn't shown at all".
  useEffect(() => {
    if (!jumpToMonth) return;
    const anchor = fromKey(jumpToMonth);
    setViewMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  }, [jumpToMonth]);

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
          const isActive = kinds.includes('active');
          const isSelected = key === selectedDate;
          const isPast = key < todayKey;
          const isBelowMin = minSelectableDate ? key < minSelectableDate : false;
          const weekday = fromKey(key).getDay();
          const isBlocked = isSkip || isActive || blockedDates.includes(key) || (!weekendEnabled && (weekday === 0 || weekday === 6));
          const selectable = !!onSelectDate && !isPast && !isBelowMin && !isBlocked;
          // A marked date (skip or resume) is a full filled circle behind
          // the number, not a small dot — resume wins if a date is somehow
          // both (rare: a resume date landing on another row's skip date).
          const markerColor = isSkip ? '#DC2626' : isActive ? '#64748B' : isResume ? '#16A34A' : null;
          return (
            <button
              key={i}
              type="button"
              disabled={!selectable}
              onClick={() => selectable && onSelectDate(key)}
              style={{
                position: 'relative',
                height: 34,
                width: 34,
                margin: '0 auto',
                borderRadius: '50%',
                border: isSelected ? '2px solid var(--color-accent)' : '1px solid transparent',
                background: markerColor || (isSelected ? 'var(--color-accent-100)' : 'transparent'),
                color: markerColor ? '#ffffff' : (isPast || isBelowMin || isBlocked ? 'var(--color-neutral-400)' : 'var(--color-text)'),
                fontWeight: markerColor ? 700 : 400,
                cursor: selectable ? 'pointer' : 'default',
                fontSize: 12.5,
                fontFamily: 'inherit',
              }}
              aria-label={`${key}${isSkip ? ', paused (fixed)' : isActive ? ', active delivery (unavailable)' : isResume ? ', resume delivery' : ''}`}
              aria-pressed={isSelected}
              title={isSkip ? 'Paused day (fixed)' : isActive ? 'Active delivery (unavailable)' : isResume ? 'Resumes here' : undefined}
            >
              {Number(key.slice(8, 10))}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 11.5, color: 'var(--color-neutral-600)' }}>
        <span><span style={{ width: 9, height: 9, borderRadius: 999, background: '#DC2626', display: 'inline-block', marginRight: 4 }} />Paused</span>
        <span><span style={{ width: 9, height: 9, borderRadius: 999, background: '#16A34A', display: 'inline-block', marginRight: 4 }} />Resumes</span>
        <span><span style={{ width: 9, height: 9, borderRadius: 999, background: '#64748B', display: 'inline-block', marginRight: 4 }} />Active delivery</span>
      </div>
    </div>
  );
};

export default PauseCalendarGrid;
export { toDateKey };
