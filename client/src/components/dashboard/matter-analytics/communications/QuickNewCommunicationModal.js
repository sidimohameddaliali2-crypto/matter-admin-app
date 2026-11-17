import React, { useCallback, useEffect, useRef } from 'react';
import QuickReportForm from './QuickReportForm';
import { recordActivityChange } from '../../../../utils/activityCapture';

function QuickNewCommunicationModal({ onClose, onSubmitted }) {
  const dialog = useRef(null);
  const close = useCallback(() => {recordActivityChange({field:'Communication view',before:'Open',after:'Closed',form:'New communication',element:dialog.current});onClose();},[onClose]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="mo-modal-backdrop" style={{ zIndex: 210 }} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={dialog} className="mo-modal mo-modal-narrow mo-modal-skin" role="dialog" aria-modal="true" aria-label="New communication">
        <div className="mo-modal-head">
          <div><h2>New communication</h2><p>Report a delivery issue for a customer.</p></div>
          <button type="button" className="mo-btn" onClick={close}>Close</button>
        </div>
        <div style={{ marginTop: 14 }}>
          <QuickReportForm
            onCancel={close}
            onSubmitted={(issue) => { onSubmitted?.(issue); onClose(); }}
          />
        </div>
      </div>
    </div>
  );
}

export default QuickNewCommunicationModal;
