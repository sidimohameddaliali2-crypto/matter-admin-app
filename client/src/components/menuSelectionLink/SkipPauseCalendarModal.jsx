import React, { useEffect, useMemo, useState } from 'react';
import PauseCalendarGrid from './PauseCalendarGrid';

const fmtShort = (key) => {
  if (!key) return '';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

/**
 * Pre-submit confirmation for the days a customer just marked skipped: shows
 * every skip date and its suggested Matter resume date together on one
 * calendar (PauseCalendarGrid), lets the customer change a resume date
 * while keeping the pause dates fixed — all within this one view, no per-date
 * modal — and only calls onConfirm (which actually submits everything, see
 * doSubmit in MenuSelectionLink.jsx) once they're happy with all of them.
 *
 * `pauses`: [{ date, alreadyPaused, suggestedResumeDate, error? }] from
 * POST .../skip-pause-preview. A row stays editable unless `alreadyPaused`
 * (Matter already has that day paused from an earlier submit — nothing to
 * confirm for it). The calendar only changes resume dates; pauses cannot
 * be removed here.
 */
const SkipPauseCalendarModal = ({ open, loading, pauses, submitting, preview, weekendEnabled = false, activeDeliveryDates = [], unavailableDates = [], availabilityError, onCancel, onConfirm }) => {
  const [drafts, setDrafts] = useState([]);
  const [editingDate, setEditingDate] = useState(null);
  const [bulkEditing, setBulkEditing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBulkEditing(false);
    setDrafts((pauses || []).map((p) => ({
      date: p.date,
      alreadyPaused: !!p.alreadyPaused,
      resumeDate: p.suggestedResumeDate || null,
      action: 'pause',
    })));
    setEditingDate((pauses || []).find((p) => !p.alreadyPaused)?.date || null);
  }, [open, pauses]);

  const markers = useMemo(() => {
    const out = [];
    drafts.forEach((d) => {
      out.push({ date: d.date, kind: 'skip' });
      if (d.action === 'pause' && d.resumeDate) out.push({ date: d.resumeDate, kind: 'resume' });
    });
    activeDeliveryDates.forEach((date) => out.push({ date, kind: 'active' }));
    return out;
  }, [drafts, activeDeliveryDates]);

  // The calendar opens showing RESUME dates by default, not skip dates — the
  // skip date is already known (the customer just picked it); the resume
  // date is the new information they came here to see, and it's usually in a
  // later month (right after cycle end) than the skip date itself. Falls
  // back to the earliest skip date only when no resume date is known yet
  // (e.g. the preview couldn't resolve one and the customer must pick
  // manually). Derived from the `pauses` PROP, not `drafts` state:
  // PauseCalendarGrid reads this once at mount, and it first mounts in the
  // very render where `loading` flips to false — the `drafts`-reseeding
  // effect above hasn't run yet at that point, so `drafts` would still be one
  // render stale (no resume dates) and the grid would open on the wrong month.
  const earliestResumeDate = (pauses || [])
    .map((p) => p.suggestedResumeDate)
    .filter(Boolean)
    .reduce((min, d) => (!min || d < min ? d : min), null);
  const earliestSkipDate = (pauses || [])
    .map((p) => p.date)
    .filter(Boolean)
    .reduce((min, d) => (!min || d < min ? d : min), null);
  const earliestDate = earliestResumeDate || earliestSkipDate;
  const activeDraft = drafts.find((d) => d.date === editingDate);
  // Suggestions start after cycle end, but an earlier free date is also
  // valid provided it follows the pause and has no active Matter delivery.
  const editableDrafts = drafts.filter((d) => !d.alreadyPaused);
  const minResumeDate = (bulkEditing ? editableDrafts.map((d) => d.date).sort().pop() : activeDraft?.date) || null;
  const blockedDates = [...activeDeliveryDates, ...unavailableDates, ...drafts.flatMap((d) => [d.date, ...((!bulkEditing && d.date !== editingDate || d.alreadyPaused) && d.resumeDate ? [d.resumeDate] : [])])];
  const allResolved = !availabilityError && drafts.length > 0 && drafts.every((d) => d.alreadyPaused || (!!d.resumeDate && !activeDeliveryDates.includes(d.resumeDate) && !unavailableDates.includes(d.resumeDate)));
  const selectDate = (dateKey) => {
    if (!bulkEditing) {
      setDrafts((list) => list.map((d) => d.date === editingDate ? { ...d, resumeDate: dateKey } : d));
      return;
    }
    const selected = editableDrafts.map((d) => d.resumeDate).filter(Boolean);
    const dates = selected.includes(dateKey) ? selected.filter((d) => d !== dateKey) : [...selected, dateKey];
    if (dates.length > editableDrafts.length) return;
    dates.sort();
    setDrafts((list) => {
      let i = 0;
      return list.map((d) => d.alreadyPaused ? d : { ...d, resumeDate: dates[i++] || null });
    });
  };

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      style={{ position: preview ? 'absolute' : 'fixed', inset: 0, borderRadius: preview ? 34 : 0, zIndex: 65, padding: 22 }}
    >
      <div className="dialog elev-lg" role="dialog" aria-modal="true" aria-labelledby="skip-pause-title" style={{ maxWidth: '100%', width: 'min(440px, 100%)', maxHeight: '90dvh', overflowY: 'auto' }}>
        <h6 className="text-muted" style={{ margin: 0 }}>Before you finish</h6>
        <div id="skip-pause-title" className="dialog-title" style={{ fontSize: 20 }}>
          {drafts.length > 1 ? 'Confirm your skipped days' : 'Confirm your skipped day'}
        </div>
        <div className="dialog-body" style={{ opacity: 1 }}>
          <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.6 }}>
            No meals will be delivered on the paused days below. We suggest resume dates after your cycle ends;
            you can choose other available dates. Days with an active delivery cannot be selected.
            Your paused days are fixed and cannot be removed here.
          </p>

          {loading ? (
            <p className="text-muted" style={{ fontSize: 13 }}>Checking available resume dates…</p>
          ) : (
            <>
              {availabilityError && <p role="alert">{availabilityError}</p>}
              {editableDrafts.length > 1 && (
                <button type="button" className="btn btn-secondary" disabled={submitting || !!availabilityError} onClick={() => {
                  setBulkEditing(true);
                  setDrafts((list) => list.map((d) => d.alreadyPaused ? d : { ...d, resumeDate: null }));
                }}>Choose multiple resume dates</button>
              )}
              <PauseCalendarGrid
                initialMonth={earliestDate}
                markers={markers}
                selectedDate={bulkEditing ? null : activeDraft?.resumeDate}
                minSelectableDate={minResumeDate}
                blockedDates={blockedDates}
                weekendEnabled={weekendEnabled}
                // Jump the view to wherever this row's current resume date
                // is the moment editing starts — it's often a different
                // month than the skip date itself (see PauseCalendarGrid).
                jumpToMonth={bulkEditing ? earliestDate : editingDate ? (drafts.find((d) => d.date === editingDate)?.resumeDate || editingDate) : null}
                onSelectDate={(bulkEditing || editingDate) && !submitting && !availabilityError ? selectDate : undefined}
              />
              {bulkEditing && <p role="status" style={{ fontSize: 12.5 }}>
                Choose {editableDrafts.length} resume dates. {editableDrafts.filter((d) => d.resumeDate).length} of {editableDrafts.length} selected. Tap a green date to deselect it. Active deliveries are unavailable.
              </p>}
              {activeDraft && !bulkEditing && (
                <p role="status" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
                  Tap a calendar day to change the resume date for the pause on {fmtShort(activeDraft.date)}.
                </p>
              )}
              {!bulkEditing && !availabilityError && drafts.some((d) => !d.alreadyPaused && !d.resumeDate) && (
                <p role="alert" style={{ fontSize: 12.5 }}>
                  We couldn't load a suggested resume date. Please choose one on the calendar.
                </p>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
                {drafts.map((d) => (
                  <div
                    key={d.date}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                      padding: '9px 11px', borderRadius: 'var(--radius-md)',
                      background: editingDate === d.date ? 'var(--color-accent-100)' : 'var(--color-neutral-100)',
                      border: editingDate === d.date ? '1px solid var(--color-accent-400)' : '1px solid transparent',
                    }}
                  >
                    <div style={{ fontSize: 12.5 }}>
                      <div style={{ fontWeight: 600 }}>Paused {fmtShort(d.date)} (fixed)</div>
                      <div className="text-muted" style={{ fontSize: 11.5 }}>
                        {d.alreadyPaused
                          ? 'Already paused'
                          : d.resumeDate
                              ? `Resumes ${fmtShort(d.resumeDate)}`
                              : 'Pick a resume date'}
                      </div>
                    </div>
                    {d.alreadyPaused ? null : (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: 11.5, padding: '4px 10px' }}
                          disabled={submitting}
                          aria-pressed={editingDate === d.date}
                          onClick={() => { setBulkEditing(false); setEditingDate(d.date); }}
                        >
                          {!bulkEditing && editingDate === d.date ? 'Editing resume' : 'Change resume'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting} style={{ fontSize: 13.5 }}>
            Back
          </button>
          <button
            className="btn btn-primary"
            disabled={loading || submitting || !allResolved}
            onClick={() => onConfirm(drafts.map((d) => ({ date: d.date, action: d.action, resumeDate: d.resumeDate, alreadyPaused: d.alreadyPaused })))}
            style={{ fontSize: 13.5 }}
          >
            {submitting ? 'Confirming…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SkipPauseCalendarModal;
