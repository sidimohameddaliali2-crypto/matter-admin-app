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
 * calendar (PauseCalendarGrid), lets the customer change a resume date or
 * decline the pause for any of them — all within this one view, no per-date
 * modal — and only calls onConfirm (which actually submits everything, see
 * doSubmit in MenuSelectionLink.jsx) once they're happy with all of them.
 *
 * `pauses`: [{ date, alreadyPaused, suggestedResumeDate, error? }] from
 * POST .../skip-pause-preview. A row stays editable unless `alreadyPaused`
 * (Matter already has that day paused from an earlier submit — nothing to
 * confirm for it). "Unpause" declines the Matter pause for that date only —
 * the day is still skipped on the menu (no meals delivered), it just won't
 * be rescheduled by Matter; see MenuSelectionRecord.skippedDays.pauseStatus
 * 'declined'.
 */
const SkipPauseCalendarModal = ({ open, loading, pauses, submitting, preview, onCancel, onConfirm }) => {
  const [drafts, setDrafts] = useState([]);
  const [editingDate, setEditingDate] = useState(null);

  useEffect(() => {
    if (!open) return;
    setDrafts((pauses || []).map((p) => ({
      date: p.date,
      alreadyPaused: !!p.alreadyPaused,
      resumeDate: p.alreadyPaused ? null : (p.suggestedResumeDate || null),
      action: 'pause',
    })));
    setEditingDate(null);
  }, [open, pauses]);

  const markers = useMemo(() => {
    const out = [];
    drafts.forEach((d) => {
      out.push({ date: d.date, kind: 'skip' });
      if (d.action === 'pause' && d.resumeDate) out.push({ date: d.resumeDate, kind: 'resume' });
    });
    return out;
  }, [drafts]);

  // The earliest of every skip AND resume date together — resume dates are
  // placed right after the subscription's cycle end, which is often a
  // different (sometimes earlier) month than the skipped day itself, so
  // opening on just the skip date's month could hide them off-screen.
  // Derived from the `pauses` PROP, not `drafts` state: PauseCalendarGrid
  // reads this once at mount, and it first mounts in the very render where
  // `loading` flips to false — the `drafts`-reseeding effect below hasn't run
  // yet at that point, so `drafts` would still be one render stale (no
  // resume dates) and the grid would open on the wrong month.
  const earliestDate = (pauses || []).reduce((min, p) => {
    let next = (!min || p.date < min) ? p.date : min;
    if (p.suggestedResumeDate && (!next || p.suggestedResumeDate < next)) next = p.suggestedResumeDate;
    return next;
  }, null);
  const minResumeDate = drafts.reduce((min, d) => (d.resumeDate && (!min || d.resumeDate < min) ? d.resumeDate : min), null);

  const allResolved = drafts.every((d) => d.alreadyPaused || d.action === 'decline' || !!d.resumeDate);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      style={{ position: preview ? 'absolute' : 'fixed', inset: 0, borderRadius: preview ? 34 : 0, zIndex: 65, padding: 22 }}
    >
      <div className="dialog elev-lg" style={{ maxWidth: '100%', width: 'min(440px, 100%)' }}>
        <h6 className="text-muted" style={{ margin: 0 }}>Before you finish</h6>
        <div className="dialog-title" style={{ fontSize: 20 }}>
          {drafts.length > 1 ? 'Confirm your skipped days' : 'Confirm your skipped day'}
        </div>
        <div className="dialog-body" style={{ opacity: 1 }}>
          <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.6 }}>
            No meals will be delivered on the day(s) below. We'll pause your Matter deliveries and resume them on the
            date shown — tap a day on the calendar to change it, or unpause a date to leave it to us.
          </p>

          {loading ? (
            <p className="text-muted" style={{ fontSize: 13 }}>Checking available resume dates…</p>
          ) : (
            <>
              <PauseCalendarGrid
                initialMonth={earliestDate}
                markers={markers}
                selectedDate={editingDate}
                minSelectableDate={minResumeDate}
                onSelectDate={editingDate ? (dateKey) => {
                  setDrafts((list) => list.map((d) => (d.date === editingDate ? { ...d, resumeDate: dateKey, action: 'pause' } : d)));
                  setEditingDate(null);
                } : undefined}
              />

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
                      <div style={{ fontWeight: 600 }}>{fmtShort(d.date)}</div>
                      <div className="text-muted" style={{ fontSize: 11.5 }}>
                        {d.alreadyPaused
                          ? 'Already paused'
                          : d.action === 'decline'
                            ? "Won't be rescheduled"
                            : d.resumeDate
                              ? `Resumes ${fmtShort(d.resumeDate)}`
                              : 'Pick a resume date'}
                      </div>
                    </div>
                    {d.alreadyPaused ? null : (
                      <div style={{ display: 'flex', gap: 6 }}>
                        {d.action === 'pause' ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ fontSize: 11.5, padding: '4px 10px' }}
                              onClick={() => setEditingDate(editingDate === d.date ? null : d.date)}
                            >
                              {editingDate === d.date ? 'Picking…' : 'Change'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: 11.5, padding: '4px 6px' }}
                              onClick={() => setDrafts((list) => list.map((x) => (x.date === d.date ? { ...x, action: 'decline' } : x)))}
                            >
                              Unpause
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ fontSize: 11.5, padding: '4px 10px' }}
                            onClick={() => setDrafts((list) => list.map((x) => (x.date === d.date ? { ...x, action: 'pause' } : x)))}
                          >
                            Pause again
                          </button>
                        )}
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
