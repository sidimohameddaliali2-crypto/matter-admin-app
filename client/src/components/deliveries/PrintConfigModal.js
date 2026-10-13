import React, { useMemo, useRef, useState } from 'react';
import StickerDesignerModal from '../stickers/StickerDesignerModal';
import BagTagPrintModal from '../BagTagPrintModal';

const CONTENT_FIELDS = [
  { key: 'showDeliveryId', label: 'Delivery ID' },
  { key: 'showCustomerId', label: 'Customer ID' },
  { key: 'showAddress', label: 'Address' },
  { key: 'showZone', label: 'Zone' },
  { key: 'showCompany', label: 'Company' },
  { key: 'showScheduledTime', label: 'Scheduled Time' },
  { key: 'showDriverName', label: 'Driver Name' },
  { key: 'showNotes', label: 'Notes' },
];

const DEFAULT_CONTENT_FLAGS = {
  showDeliveryId: true,
  showCustomerId: true,
  showAddress: false,
  showZone: true,
  showCompany: false,
  showScheduledTime: true,
  showDriverName: false,
  showNotes: false,
};

// Sticker parameters not exposed in this UI — fixed presets rather than user-editable
// fields per the agreed defaults: A4 sheet, 2-per-row / 4-per-page, square borders,
// no color band, no header/footer text.
const STICKER_FIXED_DEFAULTS = {
  paperSize: 'A4',
  columns: 2,
  autoFitColumns: false,
  rows: 4,
  borderStyle: 'square',
  driverColorMode: 'none',
  headerText: '',
  footerText: '',
};

function getZones(deliveries) {
  const zones = new Set();
  (deliveries || []).forEach((d) => { if (d?.zone) zones.add(d.zone); });
  return Array.from(zones).sort((a, b) => a.localeCompare(b));
}

function getDefaultPrintDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

function PrintConfigModal({ deliveries, onClose, selectedDate }) {
  const [activeTab, setActiveTab] = useState('sticker');

  const [stickerWidth, setStickerWidth] = useState(105);
  const [stickerHeight, setStickerHeight] = useState(74.25);
  const [excludedZones, setExcludedZones] = useState(() => new Set());
  const [contentFlags, setContentFlags] = useState(DEFAULT_CONTENT_FLAGS);

  const [bagTagWidth, setBagTagWidth] = useState(60);
  const [bagTagHeight, setBagTagHeight] = useState(70);
  const [bagTagPrintDate, setBagTagPrintDate] = useState(() => selectedDate || getDefaultPrintDate());

  const zones = useMemo(() => getZones(deliveries), [deliveries]);

  const stickerRef = useRef(null);
  const bagTagRef = useRef(null);

  const toggleZone = (zone) => {
    setExcludedZones((prev) => {
      const next = new Set(prev);
      if (next.has(zone)) next.delete(zone); else next.add(zone);
      return next;
    });
  };

  const toggleContentFlag = (key) => {
    setContentFlags((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handlePrintDesign = () => {
    if (!deliveries || deliveries.length === 0) {
      alert('No deliveries available to print.');
      return;
    }
    if (activeTab === 'sticker') {
      stickerRef.current?.print();
    } else {
      bagTagRef.current?.print();
    }
    onClose();
  };

  const inputCls = 'w-full bg-gray-50 border border-gray-200 rounded py-2 px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white transition-colors';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 px-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-900">Print Configuration</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex border-b border-gray-100 px-6">
          <button
            onClick={() => setActiveTab('sticker')}
            className={`py-3 px-1 mr-6 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === 'sticker' ? 'text-blue-600 border-blue-600' : 'text-gray-500 border-transparent hover:text-gray-700'
            }`}
          >
            Sticker Print
          </button>
          <button
            onClick={() => setActiveTab('bagtag')}
            className={`py-3 px-1 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === 'bagtag' ? 'text-blue-600 border-blue-600' : 'text-gray-500 border-transparent hover:text-gray-700'
            }`}
          >
            Bag Tag Print
          </button>
        </div>

        <div className="p-6 space-y-5">
          {activeTab === 'sticker' ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Width (mm)</label>
                  <input type="number" min="1" value={stickerWidth} onChange={(e) => setStickerWidth(Number(e.target.value) || 0)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Height (mm)</label>
                  <input type="number" min="1" value={stickerHeight} onChange={(e) => setStickerHeight(Number(e.target.value) || 0)} className={inputCls} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Exclude / Include Areas</label>
                    {zones.length > 0 && (
                      <div className="inline-flex rounded-full border border-gray-200 overflow-hidden flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => setExcludedZones(new Set())}
                          title="Include all areas"
                          className="flex items-center gap-1 pl-2 pr-2.5 py-1 text-[11px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors border-r border-gray-200"
                        >
                          <span className="material-symbols-outlined text-[14px]">check_box</span>
                          All
                        </button>
                        <button
                          type="button"
                          onClick={() => setExcludedZones(new Set(zones))}
                          title="Exclude all areas"
                          className="flex items-center gap-1 pl-2 pr-2.5 py-1 text-[11px] font-semibold text-gray-500 bg-white hover:bg-gray-50 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[14px]">check_box_outline_blank</span>
                          None
                        </button>
                      </div>
                    )}
                  </div>
                  {zones.length === 0 ? (
                    <p className="text-sm text-gray-400">No areas found.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {zones.map((zone) => (
                        <label key={zone} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!excludedZones.has(zone)}
                            onChange={() => toggleZone(zone)}
                            className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                          />
                          {zone}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Content</label>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {CONTENT_FIELDS.map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!contentFlags[key]}
                          onChange={() => toggleContentFlag(key)}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Width (mm)</label>
                <input type="number" min="1" value={bagTagWidth} onChange={(e) => setBagTagWidth(Number(e.target.value) || 0)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Height (mm)</label>
                <input type="number" min="1" value={bagTagHeight} onChange={(e) => setBagTagHeight(Number(e.target.value) || 0)} className={inputCls} />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Printed Date</label>
                <input type="date" value={bagTagPrintDate} onChange={(e) => setBagTagPrintDate(e.target.value)} className={inputCls} />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 bg-gray-50 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-gray-700 text-sm font-medium hover:text-gray-900 transition-colors">
            Cancel
          </button>
          <button
            onClick={handlePrintDesign}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Print Design
          </button>
        </div>
      </div>

      {/* Hidden print engines — never show their own UI (isOpen=false); remounted via
          key whenever the relevant fields change so their seeded config stays current,
          then triggered synchronously via ref on "Print Design" to avoid popup blockers. */}
      <StickerDesignerModal
        key={`sticker-${stickerWidth}-${stickerHeight}-${Array.from(excludedZones).sort().join(',')}-${CONTENT_FIELDS.map(({ key }) => (contentFlags[key] ? 1 : 0)).join('')}`}
        ref={stickerRef}
        isOpen={false}
        onClose={() => {}}
        deliveries={deliveries}
        initialConfig={{
          ...STICKER_FIXED_DEFAULTS,
          stickerWidth,
          stickerHeight,
          excludedZones: Array.from(excludedZones),
          ...contentFlags,
        }}
      />
      <BagTagPrintModal
        key={`bagtag-${bagTagWidth}-${bagTagHeight}-${bagTagPrintDate}`}
        ref={bagTagRef}
        isOpen={false}
        onClose={() => {}}
        deliveries={deliveries}
        initialWidth={bagTagWidth}
        initialHeight={bagTagHeight}
        initialGroupBy="all"
        initialPrintDate={bagTagPrintDate}
      />
    </div>
  );
}

export default PrintConfigModal;
