import React, { useEffect, useMemo, useState } from 'react';
import PauseCalendarGrid from './PauseCalendarGrid';

const fmtShort = (key) => {
  if (!key) return '';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

// New pauses require explicit selections. Dates are paired chronologically.
const SkipPauseCalendarModal = ({ open, loading, pauses, submitting, preview, weekendEnabled = false, activeDeliveryDates = [], unavailableDates = [], availabilityError, submissionError, onCancel, onConfirm }) => {
  const [drafts, setDrafts] = useState([]);
  useEffect(() => {
    if (!open) return;
    setDrafts((pauses || []).map((p) => ({
      date: p.date,
      alreadyPaused: !!p.alreadyPaused,
      resumeDate: null,
      action: 'pause',
    })).sort((a, b) => a.date.localeCompare(b.date)));
  }, [open, pauses]);

  const markers = useMemo(() => {
    const out = activeDeliveryDates.map((date) => ({ date, kind: 'active' }));
    drafts.forEach((d) => {
      out.push({ date: d.date, kind: 'skip' });
      if (d.resumeDate) out.push({ date: d.resumeDate, kind: 'resume' });
    });
    return out;
  }, [drafts, activeDeliveryDates]);

  const editable = drafts.filter((d) => !d.alreadyPaused);
  const selected = editable.map((d) => d.resumeDate).filter(Boolean);
  const blockedDates = [...activeDeliveryDates, ...unavailableDates, ...drafts.map((d) => d.date), ...drafts.filter((d) => d.alreadyPaused && d.resumeDate).map((d) => d.resumeDate)];
  const allResolved = !availabilityError && drafts.length > 0 && editable.every((d) => d.resumeDate && !blockedDates.includes(d.resumeDate));
  const initialMonth = [...activeDeliveryDates, ...unavailableDates, ...(pauses || []).map((p) => p.date)]
    .filter(Boolean).sort().pop();
  const minResumeDate = editable.map((d) => d.date).sort().pop() || null;

  const selectDate = (dateKey) => {
    const dates = selected.includes(dateKey) ? selected.filter((d) => d !== dateKey) : [...selected, dateKey];
    if (dates.length > editable.length) return;
    dates.sort();
    setDrafts((list) => {
      let i = 0;
      return list.map((d) => d.alreadyPaused ? d : { ...d, resumeDate: dates[i++] || null });
    });
  };

  if (!open) return null;
  return (
    <div className="dialog-backdrop" style={{ position: preview ? 'absolute' : 'fixed', inset: 0, borderRadius: preview ? 34 : 0, zIndex: 65, padding: 22 }}>
      <div className="dialog elev-lg" role="dialog" aria-modal="true" aria-labelledby="skip-pause-title" style={{ maxWidth: '100%', width: 'min(440px, 100%)', maxHeight: '90dvh', overflowY: 'auto' }}>
        <div id="skip-pause-title" className="dialog-title" style={{ fontSize: 20 }}>Choose your resume dates</div>
        <div className="dialog-body" style={{ opacity: 1 }}>
          <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.6 }}>
            Please select the resume date.
          </p>
          {loading ? <p className="text-muted">Loading dates…</p> : (
            <>
              {availabilityError && <p role="alert">{availabilityError}</p>}
              {submissionError && <p role="alert">{submissionError}</p>}
              <PauseCalendarGrid initialMonth={initialMonth} markers={markers} selectedDates={selected}
                minSelectableDate={minResumeDate} blockedDates={blockedDates} weekendEnabled={weekendEnabled}
                onSelectDate={!submitting && !availabilityError && editable.length ? selectDate : undefined} />
              <p role="status" style={{ fontSize: 12.5 }}>{selected.length} of {editable.length} resume dates selected</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {drafts.map((d) => (
                  <div key={d.date} style={{ fontSize: 12.5, padding: '9px 11px', borderRadius: 'var(--radius-md)', background: 'var(--color-neutral-100)' }}>
                    <span style={{ color: '#DC2626', fontWeight: 600 }}>Paused {fmtShort(d.date)}</span>
                    <span>{d.alreadyPaused ? ' — Already paused' : d.resumeDate ? ' → Resume ' + fmtShort(d.resumeDate) : ' → Choose a resume date'}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>Back</button>
          <button className="btn btn-primary" disabled={loading || submitting || !allResolved}
            onClick={() => onConfirm(drafts.map(({ date, action, resumeDate, alreadyPaused }) => ({ date, action, resumeDate, alreadyPaused })))}>
            {submitting ? 'Confirming…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SkipPauseCalendarModal;
