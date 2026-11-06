import React, { useState, useMemo, useEffect, useImperativeHandle, forwardRef } from 'react';
import api from '../utils/api';
import { useSelector } from 'react-redux';
import { X, Printer, Upload, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const BagTagPrintModal = forwardRef(({
  deliveries,
  onClose,
  isOpen = true,
  initialWidth = null,
  initialHeight = null,
  initialGroupBy = null,
  initialPrintDate = null,
}, ref) => {
  const canSaveSharedLogo = useSelector(state => ['admin', 'super_admin'].includes(state.auth.user?.role));
  const [stickerSize, setStickerSize] = useState(() => (initialWidth || initialHeight) ? 'custom' : 'medium'); // 'small' | 'medium' | 'large' | 'custom'
  const [customWidth, setCustomWidth] = useState(() => initialWidth || 100);
  const [customHeight, setCustomHeight] = useState(() => initialHeight || 100);
  const [measurementUnit, setMeasurementUnit] = useState('mm'); // 'mm' | 'inch' | 'cm'
  const [groupBy, setGroupBy] = useState(() => initialGroupBy || 'driver'); // 'driver' | 'all'
  const [previewMode, setPreviewMode] = useState(false);
  const [logoUrl, setLogoUrl] = useState('');
  const [logoPreview, setLogoPreview] = useState('');
  const [selectedLogoFile, setSelectedLogoFile] = useState(null);
  const [loadingLogo, setLoadingLogo] = useState(false);
  const [savingLogo, setSavingLogo] = useState(false);

  // Get tomorrow's date as default print date
  const getDefaultPrintDate = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  };

  const [printDate, setPrintDate] = useState(() => initialPrintDate || getDefaultPrintDate());
  const STORAGE_KEY = 'bag-tag-print-size';

  const getServerOrigin = () => {
    try {
      const base = api?.defaults?.baseURL || '';
      if (base.startsWith('http')) {
        return new URL(base).origin;
      }
    } catch (err) {
      // Ignore and fall back
    }
    return window.location.origin;
  };

  // Fallback: try any existing logo file already on the server under /uploads/bag-tags
  const tryLoadLocalLogo = async () => {
    const base = `${getServerOrigin()}/uploads/bag-tags`;
    const exts = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
    for (const ext of exts) {
      const url = `${base}/logo.${ext}`;
      try {
        const resp = await fetch(url, { method: 'GET' });
        if (resp.ok) {
          setLogoUrl(url);
          setLogoPreview(url);
          return true;
        }
      } catch (err) {
        // Ignore and continue
      }
    }
    return false;
  };

  useEffect(() => {
    // When mounted as a hidden print engine (isOpen=false), the caller's
    // initialWidth/initialHeight/etc. are the source of truth — don't let a
    // stale localStorage preference silently override them.
    if (!isOpen) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.stickerSize) setStickerSize(saved.stickerSize);
      if (saved.customWidth) setCustomWidth(saved.customWidth);
      if (saved.customHeight) setCustomHeight(saved.customHeight);
      if (saved.measurementUnit) setMeasurementUnit(saved.measurementUnit);
    } catch (err) {
      console.error('Failed to load saved print size', err);
    }
  }, []);

  useEffect(() => {
    const fetchLogo = async () => {
      try {
        setLoadingLogo(true);
        const resp = await api.get('/upload/bag-tag-logo');
        if (resp?.data?.url) {
          setLogoUrl(resp.data.url);
          setLogoPreview(resp.data.url);
          return;
        }
        await tryLoadLocalLogo();
      } catch (err) {
        const loaded = await tryLoadLocalLogo();
        if (!loaded && err?.response?.status !== 404) {
          console.error('Failed to load logo', err);
        }
      } finally {
        setLoadingLogo(false);
      }
    };
    fetchLogo();
  }, []);

  const handleSaveSize = () => {
    try {
      const payload = {
        stickerSize,
        customWidth,
        customHeight,
        measurementUnit
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      alert('Saved bag tag print size');
    } catch (err) {
      console.error('Failed to save print size', err);
      alert('Could not save size settings');
    }
  };

  // Handle logo upload (local preview) + optional server save
  const handleLogoUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedLogoFile(file);
      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = event.target?.result;
        setLogoPreview(dataUrl);
        setLogoUrl(dataUrl);
      };
      reader.readAsDataURL(file);
    }
  };

  const uploadLogoToServer = async () => {
    if (!selectedLogoFile) {
      alert('Please choose a logo file first');
      return;
    }
    try {
      setSavingLogo(true);
      const formData = new FormData();
      formData.append('image', selectedLogoFile);
      const resp = await api.post('/upload/bag-tag-logo', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      if (resp?.data?.url) {
        setLogoUrl(resp.data.url);
        setLogoPreview(resp.data.url);
        alert('Logo saved for all users');
      }
    } catch (err) {
      console.error('Upload logo failed', err);
      alert('Failed to save logo');
    } finally {
      setSavingLogo(false);
    }
  };

  // A delivery combined with its customer's Sunday delivery (see
  // applyWeekendCombining server-side — `combinedSunday` on a Saturday
  // delivery) represents TWO meals handed over in one physical drop-off; the
  // Sunday record itself is deliberately excluded from list results so it
  // doesn't look like a separate stop. Print both bag tags automatically
  // here too, same as StickerDesignerModal: the Saturday tag as-is, plus a
  // Sunday-dated clone. Bag tags show a single admin-picked `printDate` on
  // every tag rather than each delivery's own scheduledTime, so the clone
  // carries an explicit `_bagTagDate` override the print markup falls back
  // to instead of `printDate`.
  const expandedDeliveries = useMemo(() => {
    const list = Array.isArray(deliveries) ? deliveries : [];
    const expanded = [];
    list.forEach((delivery) => {
      // A customer with only a Sunday meal (no Saturday order) is carried
      // into Saturday's list by the server (`sundayOnlyCarriedOver`) since
      // there's no separate Sunday route — its own scheduledTime is already
      // Sunday's real date, so the bag tag just needs to use that instead of
      // the admin's global printDate.
      if (delivery?.sundayOnlyCarriedOver && delivery?.scheduledTime) {
        expanded.push({ ...delivery, _bagTagDate: delivery.scheduledTime });
        return;
      }
      expanded.push(delivery);
      if (delivery?.combinedSunday?.scheduledTime) {
        const baseId = delivery._id || delivery.id;
        expanded.push({
          ...delivery,
          _id: `${baseId}-sunday`,
          id: `${baseId}-sunday`,
          combinedSunday: null,
          _bagTagDate: delivery.combinedSunday.scheduledTime,
        });
      }
    });
    return expanded;
  }, [deliveries]);

  // Get unique drivers from deliveries
  const drivers = useMemo(() => {
    const driverMap = {};
    expandedDeliveries.forEach(d => {
      if (d.driver?._id) {
        const driverId = d.driver._id;
        if (!driverMap[driverId]) {
          driverMap[driverId] = {
            _id: driverId,
            name: (d.driver.profile?.firstName || '') + (d.driver.profile?.lastName ? ` ${d.driver.profile.lastName}` : '') || d.driver.email || 'Unassigned',
            colorCode: d.driver.profile?.colorCode || '#999999',
            deliveries: []
          };
        }
        driverMap[driverId].deliveries.push(d);
      }
    });
    return Object.values(driverMap);
  }, [expandedDeliveries]);

  // Organize deliveries by driver or all
  const organizedDeliveries = useMemo(() => {
    if (groupBy === 'driver') {
      return drivers.map(driver => ({
        label: driver.name,
        colorCode: driver.colorCode,
        items: driver.deliveries
      }));
    }
    // All together
    return [{
      label: 'All Deliveries',
      colorCode: '#6366f1',
      items: expandedDeliveries
    }];
  }, [expandedDeliveries, drivers, groupBy]);

  // Sticker dimensions based on measurement unit
  const stickerDimensions = {
    small: { value: 76, padding: 3, fontSize: 'text-xs' },
    medium: { value: 100, padding: 4, fontSize: 'text-sm' },
    large: { value: 150, padding: 6, fontSize: 'text-base' }
  };

  const convertToMM = (value, unit) => {
    switch(unit) {
      case 'inch': return value * 25.4;
      case 'cm': return value * 10;
      default: return value; // mm
    }
  };

  // Get dimensions object with fallback for custom
  const dims = stickerDimensions[stickerSize] || stickerDimensions['medium'];
  
  // Get actual dimensions for printing
  let actualWidth = dims.value;
  let actualHeight = dims.value;
  let actualPadding = dims.padding;
  let actualFontSize = stickerSize === 'small' ? '7px' : stickerSize === 'medium' ? '8.5px' : '10px';
  
  if (stickerSize === 'custom') {
    actualWidth = convertToMM(customWidth, measurementUnit);
    actualHeight = convertToMM(customHeight, measurementUnit);
    actualPadding = Math.max(2, Math.round(actualWidth / 30));
    // Scale font based on custom size (base on medium = 100mm)
    const scale = actualWidth / 100;
    actualFontSize = `${Math.max(6, Math.round(8.5 * scale))}px`;
  }
  
  const stickerSizeMM = actualWidth;
  const displayWidth = (actualWidth / convertToMM(1, measurementUnit)).toFixed(2);
  const displayHeight = (actualHeight / convertToMM(1, measurementUnit)).toFixed(2);

  const handlePrint = () => {
    if (!expandedDeliveries || expandedDeliveries.length === 0) {
      alert('No deliveries selected to print.');
      return;
    }
    try {
      openPrintWindow(buildPrintHtml(organizedDeliveries));
    } catch (error) {
      console.error('Print error:', error);
      alert('Failed to open print dialog. Please try again.');
    }
  };

  // Lets a parent (e.g. PrintConfigModal) trigger printing synchronously from its own
  // click handler, using this instance's current size, without showing this
  // component's own designer UI (isOpen can stay false).
  useImperativeHandle(ref, () => ({ print: handlePrint }));

  const openPrintWindow = (html) => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow pop-ups to print stickers');
      return;
    }

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();

    // onload doesn't fire reliably for document.write in every browser, so keep the
    // timeout as a fallback — but guard so print() (and thus the print dialog) only
    // ever fires once, whichever trigger wins.
    let hasPrinted = false;
    const triggerPrint = () => {
      if (hasPrinted || !printWindow || printWindow.closed) return;
      hasPrinted = true;
      printWindow.print();
    };

    printWindow.onload = triggerPrint;
    setTimeout(triggerPrint, 500);
  };

  // Generate printable HTML
  const buildPrintHtml = (groups) => {
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bag Tags</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f7f8fa;
      padding: 0;
      color: #0f172a;
    }
    
    .stickers-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      justify-content: flex-start;
    }
    
    .sticker {
      position: relative;
      width: ${stickerSizeMM}mm;
      height: ${actualHeight}mm;
      padding: 0;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 0;
      box-shadow: none;
      page-break-inside: avoid;
      break-inside: avoid;
      display: flex;
      flex-direction: column;
      gap: 0;
      overflow: hidden;
    }

    .accent-bar {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3mm;
      background: var(--accent, #6366f1);
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .sticker-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0;
      padding: 1.2mm 1.5mm 1.2mm 4.5mm;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0;
      min-width: 0;
    }

    .sticker-logo, .brand-placeholder {
      width: 12mm;
      height: 12mm;
      border-radius: 6px;
      object-fit: contain;
      background: #fff;
      padding: 1mm;
    }

    .brand-placeholder {
      display: grid;
      place-items: center;
      font-weight: 700;
      font-size: 9px;
      color: #475467;
    }

    .brand-meta {
      display: flex;
      flex-direction: column;
      gap: 0.8mm;
      min-width: 0;
    }

    .eyebrow {
      font-size: 9px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #6b7280;
      font-weight: 700;
    }

    .brand-text {
      font-size: 11px;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.25;
      white-space: normal;
    }

    .tag-chip {
      display: inline-flex;
      align-items: center;
      gap: 1mm;
      padding: 1.2mm 2.4mm;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.08);
      color: #312e81;
      font-size: 9px;
      font-weight: 700;
      border: 1px solid rgba(99, 102, 241, 0.18);
      margin-top: 0.6mm;
      width: fit-content;
    }

    .details {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0;
      font-size: 11px;
      padding: 0.8mm 1.5mm 0.8mm 4.5mm;
    }

    .detail-row {
      display: grid;
      grid-template-columns: 30% 1fr;
      gap: 0;
      align-items: start;
    }

    .label {
      font-weight: 800;
      color: #0f172a;
      font-size: 10.5px;
      line-height: 1.3;
    }

    .value {
      font-weight: 700;
      color: #111827;
      line-height: 1.35;
      word-break: break-word;
    }

    .value.address {
      overflow: hidden;
      max-height: 4.1em;
      word-break: break-all;
      overflow-wrap: break-word;
    }

    .note {
      margin-top: 1mm;
      padding: 1.5mm;
      border-radius: 6px;
      background: #f3f4f6;
      border: 1px dashed #d1d5db;
      font-size: 10px;
      color: #374151;
      word-break: break-all;
      overflow-wrap: anywhere;
      overflow: hidden;
      max-height: 3.6em;
    }

    .meta-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0;
      margin-top: auto;
      padding: 0.8mm 1.5mm 0.8mm 4.5mm;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 1.2mm;
      padding: 1.4mm 2.8mm;
      border-radius: 999px;
      font-size: 9.5px;
      font-weight: 750;
      border: 1px solid #e5e7eb;
      background: #fff;
      color: #111827;
    }

    .pill.accent {
      border-color: rgba(99, 102, 241, 0.2);
      background: rgba(99, 102, 241, 0.08);
      color: #312e81;
    }

    @media print {
      body {
        margin: 0;
        padding: 0;
        background: white;
      }
      .stickers-container {
        gap: 0;
      }
      .sticker {
        margin: 0;
      }
    }
    
    @page {
      margin: 0;
      size: auto;
    }
  </style>
</head>
<body>
  <div class="stickers-container">
`;

    groups.forEach(group => {
      group.items.forEach(delivery => {
        const colorCode = group.colorCode || '#6366f1';
        const smartTruncate = (text, maxLen) => {
          if (!text) return '';
          // Remove URLs (Google Maps links etc.) — not useful on a physical sticker
          const stripped = text.replace(/https?:\/\/[^\s]+/gi, '[link]').trim();
          return stripped.length > maxLen ? stripped.substring(0, maxLen) + '...' : stripped;
        };
        const shortAddress = escapeHtml(smartTruncate(delivery.address || 'N/A', 50));
        const shortNotes = delivery.notes ? escapeHtml(smartTruncate(delivery.notes, 45)) : '';
        
        html += `
    <div class="sticker" style="--accent: ${colorCode};">
      <div class="accent-bar"></div>
      <div class="sticker-top">
        <div class="brand">
          ${logoUrl ? `<img src="${logoUrl}" alt="Logo" class="sticker-logo">` : '<div class="brand-placeholder">Bag</div>'}
          <div class="brand-meta">
            <span class="tag-chip">Zone ${escapeHtml(delivery.zone || 'N/A')}</span>
          </div>
        </div>
      </div>
      <div class="details">
        <div class="detail-row">
          <span class="label">Customer</span>
          <span class="value">${escapeHtml(delivery.customerName || 'N/A')}</span>
        </div>
        <div class="detail-row">
          <span class="label">Address</span>
          <span class="value address">${shortAddress}</span>
        </div>
        <div class="detail-row">
          <span class="label">Zone</span>
          <span class="value">${escapeHtml(delivery.zone || 'N/A')}</span>
        </div>
        ${delivery.notes ? `
        <div class="note">${shortNotes}</div>
        ` : ''}
      </div>
      <div class="meta-footer">
        <span class="pill accent">${escapeHtml(delivery.customerId || 'Bag')}</span>
        <span class="pill">${escapeHtml(new Date(delivery._bagTagDate || printDate).toLocaleDateString())}</span>
      </div>
    </div>
`;
      });
    });

    html += `
  </div>
</body>
</html>
`;
    return html;
  };

  // Escape HTML special characters
  const escapeHtml = (text) => {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // Preview sticker
  const PreviewSticker = ({ delivery, colorCode }) => {
    const pxWidth = {
      small: 120,
      medium: 165,
      large: 220
    };

    return (
      <div
        className="relative inline-flex m-2 flex-col rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 shadow-md overflow-hidden"
        style={{
          width: `${pxWidth[stickerSize]}px`,
          height: `${pxWidth[stickerSize]}px`,
          fontSize: '0.8rem',
          padding: '10px 10px 10px 20px'
        }}
      >
        <div
          className="absolute left-0 top-0 bottom-0"
          style={{ width: '6px', backgroundColor: colorCode }}
        />

        <div className="flex items-center gap-2 min-w-0">
          {logoPreview ? (
            <img src={logoPreview} alt="Logo" className="h-10 w-10 rounded-lg bg-white object-contain p-1" />
          ) : (
            <div className="h-10 w-10 rounded-lg bg-white text-[11px] font-bold text-slate-500 grid place-items-center">
              Bag
            </div>
          )}
          <div className="min-w-0">
            <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-[3px] text-[10px] font-semibold text-indigo-800 w-fit">
              Zone {delivery.zone || 'N/A'}
            </div>
          </div>
        </div>

        <div className="mt-3 space-y-1.5 text-[11px] font-semibold text-slate-900">
          <div className="flex gap-2"><span className="text-slate-500 uppercase tracking-wide text-[9px]">Customer</span><span className="truncate">{delivery.customerName || 'N/A'}</span></div>
          <div className="flex gap-2"><span className="text-slate-500 uppercase tracking-wide text-[9px]">Address</span><span className="truncate">{delivery.address?.substring(0, 36) || 'N/A'}</span></div>
          {delivery.notes && (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-700 line-clamp-2">
              {delivery.notes.substring(0, 50)}
            </div>
          )}
        </div>

        <div className="mt-auto pt-3 flex items-center justify-between text-[10px] font-semibold text-slate-700">
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-1">{delivery.customerId || 'Bag'}</span>
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-1">{new Date(delivery._bagTagDate || printDate).toLocaleDateString()}</span>
        </div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto"
        >
          {/* Header */}
          <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-gray-900">Print Bag Tags</h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded-lg transition"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6">
            {/* Logo Upload */}
            <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Logo (Optional)
              </label>
              <div className="flex items-center gap-4">
                <label className="relative cursor-pointer">
                  <div className="px-4 py-2 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-500 transition">
                    <Upload className="w-4 h-4 mx-auto text-gray-400 mb-1" />
                    <span className="text-xs text-gray-600">Upload Logo</span>
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                </label>
                {logoPreview && (
                  <>
                    <img src={logoPreview} alt="Logo preview" className="h-12 w-12 object-contain border border-gray-300 rounded p-1" />
                    <button
                      onClick={() => {
                        setLogoUrl('');
                        setLogoPreview('');
                        setSelectedLogoFile(null);
                      }}
                      className="px-3 py-1 bg-red-100 text-red-600 rounded hover:bg-red-200 transition flex items-center gap-1 text-sm"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove
                    </button>
                    {canSaveSharedLogo && <button
                      onClick={uploadLogoToServer}
                      disabled={!selectedLogoFile || savingLogo}
                      className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition flex items-center gap-1 text-sm disabled:opacity-60"
                    >
                      {savingLogo ? 'Saving...' : 'Save for all users'}
                    </button>}
                  </>
                )}
                {!logoPreview && loadingLogo && (
                  <span className="text-xs text-gray-500">Loading saved logo...</span>
                )}
              </div>
            </div>

            {/* Settings */}
            <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
              {/* Sticker Size */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Sticker Size
                </label>
                <select
                  value={stickerSize}
                  onChange={(e) => setStickerSize(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                  <option value="custom">Custom</option>
                </select>
                <button
                  type="button"
                  onClick={handleSaveSize}
                  className="mt-2 text-xs text-blue-600 hover:text-blue-700 underline"
                >
                  Save as default
                </button>
              </div>

              {/* Print Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Print Date
                </label>
                <input
                  type="date"
                  value={printDate}
                  onChange={(e) => setPrintDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Custom Width */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Width
                </label>
                <input
                  type="number"
                  value={customWidth}
                  onChange={(e) => {
                    setStickerSize('custom');
                    setCustomWidth(Math.max(10, parseFloat(e.target.value) || 0));
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  min="10"
                  step="1"
                  placeholder="e.g. 100"
                />
              </div>

              {/* Custom Height */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Height
                </label>
                <input
                  type="number"
                  value={customHeight}
                  onChange={(e) => {
                    setStickerSize('custom');
                    setCustomHeight(Math.max(10, parseFloat(e.target.value) || 0));
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  min="10"
                  step="1"
                  placeholder="e.g. 100"
                />
              </div>

              {/* Measurement Unit */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Unit
                </label>
                <select
                  value={measurementUnit}
                  onChange={(e) => setMeasurementUnit(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="mm">Millimeters (mm)</option>
                  <option value="cm">Centimeters (cm)</option>
                  <option value="inch">Inches (in)</option>
                </select>
              </div>

              {/* Group By */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Group By
                </label>
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="all">All Together</option>
                  <option value="driver">By Driver</option>
                </select>
              </div>

              {/* Total Count */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Total Stickers
                </label>
                <div className="px-3 py-2 bg-gray-100 border border-gray-300 rounded-lg">
                  <span className="text-lg font-bold text-gray-900">
                    {expandedDeliveries.length}
                  </span>
                </div>
              </div>
            </div>

            {/* Sticker Dimensions Info */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm text-blue-900">
                <span className="font-semibold">Size:</span> {displayWidth}{measurementUnit} × {displayHeight}{measurementUnit}
              </p>
            </div>

            {/* Preview Toggle */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPreviewMode(!previewMode)}
                className={`px-4 py-2 rounded-lg border transition ${
                  previewMode
                    ? 'bg-indigo-500 text-white border-indigo-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {previewMode ? 'Hide Preview' : 'Show Preview'}
              </button>
            </div>

            {/* Preview Section */}
            {previewMode && (
              <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                <h3 className="text-sm font-medium text-gray-900 mb-3">Sticker Preview</h3>
                <div className="flex flex-wrap gap-2 justify-center max-h-96 overflow-y-auto">
                  {organizedDeliveries.map((group, groupIdx) =>
                    group.items.slice(0, 6).map((delivery, idx) => (
                      <PreviewSticker
                        key={`${groupIdx}-${idx}`}
                        delivery={delivery}
                        colorCode={group.colorCode}
                      />
                    ))
                  )}
                  {expandedDeliveries.length > 6 && (
                    <div className="text-xs text-gray-500 text-center py-2 w-full">
                      +{expandedDeliveries.length - 6} more stickers
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Driver Groups Info */}
            {groupBy === 'driver' && drivers.length > 0 && (
              <div className="border border-gray-200 rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-900 mb-3">Drivers ({drivers.length})</h3>
                <div className="space-y-2">
                  {drivers.map((driver, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-sm">
                      <div
                        className="w-4 h-4 rounded"
                        style={{ backgroundColor: driver.colorCode }}
                      />
                      <span className="text-gray-700">
                        {driver.name}: <span className="font-semibold">{driver.deliveries.length}</span> stickers
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
              <button
                onClick={onClose}
                className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={handlePrint}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2"
              >
                <Printer className="w-4 h-4" />
                Print Stickers
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
});

export default BagTagPrintModal;
