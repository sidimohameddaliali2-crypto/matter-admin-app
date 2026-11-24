import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  SATO_ALIGNMENT_KEY, SATO_STICKER_CSS, SatoDeliverySticker, buildSatoPrintMarkup,
  clampOffset, expandSatoDeliveries, fitSatoLabels, loadSatoAlignment, sortSatoDeliveries,
} from './satoStickerPrint';

export default function SatoStickerPrintModal({ deliveries = [], onClose }) {
  const [alignment, setAlignment] = useState(loadSatoAlignment);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [error, setError] = useState('');
  const [previewTooLong, setPreviewTooLong] = useState(false);
  const previewRef = useRef(null);
  const labels = useMemo(() => sortSatoDeliveries(expandSatoDeliveries(deliveries)), [deliveries]);
  const preview = labels[Math.min(previewIndex, Math.max(0, labels.length - 1))];

  useLayoutEffect(() => {
    if (previewRef.current) setPreviewTooLong(!fitSatoLabels(previewRef.current));
  }, [preview]);

  useEffect(() => {
    try { localStorage.setItem(SATO_ALIGNMENT_KEY, JSON.stringify(alignment)); } catch { /* Preview still works without storage. */ }
  }, [alignment]);

  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const print = (oneOnly) => {
    setError('');
    const targets = oneOnly ? [preview].filter(Boolean) : labels;
    if (!targets.length) { setError('No deliveries available to print.'); return; }
    const popup = window.open('', '_blank');
    if (!popup) { setError('Allow pop-ups for this site, then try printing again.'); return; }
    popup.onload = () => {
      if (!fitSatoLabels(popup.document)) {
        popup.close();
        setError('A label has too much text to fit legibly. Shorten its address before printing.');
        return;
      }
      popup.focus();
      popup.print();
    };
    popup.document.write(buildSatoPrintMarkup(targets, alignment));
    popup.document.close();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-40 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="sato-print-title" className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <style>{SATO_STICKER_CSS}</style>
        <div className="flex justify-between items-center border-b p-5">
          <h2 id="sato-print-title" className="text-lg font-bold">SATO stickers · 60 × 80 mm</h2>
          <button autoFocus onClick={onClose} aria-label="Close sticker printing" className="p-2">✕</button>
        </div>
        <div className="grid md:grid-cols-2 gap-6 p-5">
          <div className="space-y-4 text-sm">
            <p>{labels.length} sticker{labels.length === 1 ? '' : 's'} · One label per delivery. Combined Sunday deliveries get their own sticker.</p>
            <p>Print order: Abu Dhabi first, then Dubai and other deliveries. Delivery timing is shown in UAE time.</p>
            <fieldset className="space-y-3">
              <legend className="font-semibold mb-2">Box alignment</legend>
              {['x', 'y'].map((axis) => <label key={axis} className="block">
                {axis === 'x' ? 'Horizontal (mm)' : 'Vertical (mm)'}
                <input type="number" min="-3" max="3" step="0.5" value={alignment[axis]}
                  onChange={(event) => setAlignment((current) => ({ ...current, [axis]: clampOffset(event.target.value) }))}
                  className="block border rounded p-2 w-full mt-1" />
              </label>)}
              <p className="text-gray-600">Positive moves right / down; negative moves left / up. Settings are saved on this browser.</p>
              <button className="text-blue-700 underline" onClick={() => setAlignment({ x: 0, y: 0 })}>Reset alignment</button>
            </fieldset>
            <p className="text-gray-600">Choose SATO FX3-LX DT305-Ln, 60 × 80 mm stock, portrait, 100% scale, no margins, and turn off headers and footers. Check one label before printing the batch.</p>
            {error && <p role="alert" className="text-red-700">{error}</p>}
          </div>
          <div>
            <label className="block text-sm font-semibold mb-3">Preview delivery
              <select value={Math.min(previewIndex, Math.max(0, labels.length - 1))} onChange={(event) => setPreviewIndex(Number(event.target.value))} className="block border rounded p-2 w-full mt-1">
                {labels.map((delivery, index) => <option key={index} value={index}>{index + 1}. {delivery.customerName || 'Unnamed customer'}</option>)}
              </select>
            </label>
            <div ref={previewRef} className="bg-gray-100 border rounded p-3 flex justify-center overflow-x-auto" style={{ '--sato-x': `${alignment.x}mm`, '--sato-y': `${alignment.y}mm` }}>
              {preview ? <SatoDeliverySticker delivery={preview} /> : <p>No deliveries to preview.</p>}
            </div>
            {previewTooLong && <p role="status" className="mt-2 text-sm text-red-700">This label has too much text to fit. Shorten its address before printing.</p>}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-3 border-t p-5">
          <button onClick={onClose} className="px-4 py-2 border rounded">Close</button>
          <button onClick={() => print(true)} disabled={!labels.length} className="px-4 py-2 border rounded disabled:opacity-50">Print one label</button>
          <button onClick={() => print(false)} disabled={!labels.length} className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">Print {labels.length} sticker{labels.length === 1 ? '' : 's'}</button>
        </div>
      </div>
    </div>
  );
}
