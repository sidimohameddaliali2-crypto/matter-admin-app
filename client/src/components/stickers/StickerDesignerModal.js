import React, { useEffect, useImperativeHandle, useMemo, useState, forwardRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Printer, RefreshCw, Palette, Grid } from 'lucide-react';

const DEFAULT_CONFIG = {
  columns: 3,
  autoFitColumns: true, // New: automatically compute columns that fit per page width
  rows: 1,  // Number of rows per page (1-6). For 2 cols + 8 items = 4 rows
  stickerWidth: 100,  // Width in mm
  stickerHeight: 80,  // Height in mm
  stickerMargin: 0,   // Margin between stickers in mm
  paperSize: 'A4',    // Paper size: A4, Letter, A5, Legal
  showDeliveryId: true,
  showCustomerId: true,
  showAddress: true,
  showZone: true,
  showCompany: true,
  showScheduledTime: true,
  showDriverName: true,
  showNotes: false,
  headerText: 'Matter Delivery',
  footerText: 'Handle with care',
  accentColor: '#1F2937',
  textColor: '#111827',
  backgroundColor: '#FFFFFF',
  driverColorMode: 'band',
  borderStyle: 'rounded',
  excludedZones: [],
  excludedCompanies: [],
};

// Paper size dimensions in mm
const PAPER_SIZES = {
  A4: { width: 210, height: 297, label: 'A4 (210 × 297 mm)' },
  Letter: { width: 216, height: 279, label: 'Letter (8.5 × 11 in)' },
  A5: { width: 148, height: 210, label: 'A5 (148 × 210 mm)' },
  Legal: { width: 216, height: 356, label: 'Legal (8.5 × 14 in)' },
};

const DESIGN_STORAGE_KEY = 'stickerDesignerConfig';

const sanitizeColor = (value, fallback = '#000000') => {
  if (typeof value !== 'string') return fallback;
  const hex = value.trim();
  if (/^#([A-Fa-f0-9]{6})$/.test(hex)) {
    return hex.toUpperCase();
  }
  if (/^#([A-Fa-f0-9]{3})$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toUpperCase();
  }
  return fallback;
};

const escapeHtml = (value = '') =>
  value
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDateTime = (value) => {
  if (!value) return 'Not scheduled';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return 'Not scheduled';
  }
};

// Deterministic zone color generator so every zone always maps to the same color
// Generates an HSL color from a stable hash of the zone name and converts to hex
const hslToHex = (h, s, l) => {
  const sat = s / 100;
  const light = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase();
};

const hashZone = (name = '') => {
  const str = name.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const getZoneColor = (() => {
  const cache = new Map();
  return (zoneName = '') => {
    const key = zoneName.trim().toLowerCase();
    if (!key) return '#6B7280';
    if (cache.has(key)) return cache.get(key);

    // Check if custom color is saved in localStorage
    try {
      const savedColors = localStorage.getItem('zoneColors');
      if (savedColors) {
        const colorMap = JSON.parse(savedColors);
        // Try exact match first
        const exactMatch = Object.keys(colorMap).find(
          saved => saved.trim().toLowerCase() === key
        );
        if (exactMatch && colorMap[exactMatch]) {
          const color = colorMap[exactMatch];
          cache.set(key, color);
          return color;
        }
      }
    } catch (error) {
      console.warn('Failed to load saved zone colors:', error);
    }

    // Fallback to deterministic color generation
    const hash = hashZone(key);
    const hue = hash % 360;
    const color = hslToHex(hue, 65, 55);
    cache.set(key, color);
    return color;
  };
})();

// Listen for zone color updates and clear cache
if (typeof window !== 'undefined') {
  window.addEventListener('zoneColorsUpdated', () => {
    // Clear the cache when colors are updated
    const getZoneColorCache = getZoneColor;
    if (getZoneColorCache && typeof getZoneColorCache === 'function') {
      // Force re-evaluation by clearing internal cache
      // The cache will be rebuilt on next call with new colors from localStorage
      location.reload(); // Simplest approach - reload to pick up new colors
    }
  });
}

const getContrastColor = (hex = '#000000') => {
  const sanitized = hex.replace('#', '');
  const r = parseInt(sanitized.slice(0, 2), 16) || 0;
  const g = parseInt(sanitized.slice(2, 4), 16) || 0;
  const b = parseInt(sanitized.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#111827' : '#FFFFFF';
};

const getDeliveryId = (delivery) => {
  if (!delivery || typeof delivery !== 'object') return '';
  return (
    delivery._id ||
    delivery.id ||
    delivery.tempId ||
    delivery.customerId ||
    (delivery.customerName && delivery.scheduledTime
      ? `${delivery.customerName}-${delivery.scheduledTime}`
      : delivery.customerName || delivery.scheduledTime || 'delivery')
  );
};

const buildStickerData = (delivery) => {
  const profile = delivery?.driver?.profile || {};
  const driverName = [
    profile.firstName || '',
    profile.lastName || '',
  ]
    .join(' ')
    .trim();

  const zoneColor = getZoneColor(delivery?.zone);

  return {
    id: getDeliveryId(delivery) || Math.random().toString(36).slice(2),
    // The delivery record's own id (not the customer's). A Sunday copy printed
    // for a Saturday+Sunday customer carries the real Sunday delivery's id.
    deliveryId: String(delivery?.deliveryRecordId || delivery?._id || delivery?.id || ''),
    customerName: delivery?.customerName || 'Unnamed Customer',
    customerId: delivery?.customerId || 'N/A',
    address: delivery?.address || 'No address',
    zone: delivery?.zone || 'N/A',
    zoneColor,
    zoneTextColor: getContrastColor(zoneColor),
    company: delivery?.company || 'Matter',
    scheduledTime: formatDateTime(delivery?.scheduledTime),
    driverName: driverName || 'Unassigned',
    driverColor: sanitizeColor(profile.colorCode, '#0066FF'),
    notes: delivery?.notes || '',
  };
};

const StickerDesignerModal = forwardRef(({ isOpen, onClose, deliveries = [], initialConfig = null }, ref) => {
  const [config, setConfig] = useState(() => ({ ...DEFAULT_CONFIG, ...(initialConfig || {}) }));
  const [selectedStickerIds, setSelectedStickerIds] = useState(new Set());
  const [logoDataUrl, setLogoDataUrl] = useState(null);
  const [showLogo, setShowLogo] = useState(true);

  useEffect(() => {
    if (isOpen) {
      const saved = localStorage.getItem(DESIGN_STORAGE_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setConfig({
            ...DEFAULT_CONFIG,
            ...parsed,
            excludedZones: Array.isArray(parsed.excludedZones) ? parsed.excludedZones : [],
            excludedCompanies: Array.isArray(parsed.excludedCompanies) ? parsed.excludedCompanies : [],
          });
          setSelectedStickerIds(new Set());
          return;
        } catch {
          // fall back to default
        }
      }
      setConfig(DEFAULT_CONFIG);
      setSelectedStickerIds(new Set());
    }
  }, [isOpen]);

    const safeDeliveries = useMemo(() => {
      const list = Array.isArray(deliveries) ? deliveries : [];
      // A delivery combined with its customer's Sunday delivery (see
      // applyWeekendCombining server-side — `combinedSunday` on a Saturday
      // delivery) represents TWO meals handed over in one physical drop-off;
      // the Sunday record itself is deliberately excluded from list results
      // so it doesn't look like a separate stop. Print both labels
      // automatically here instead: the Saturday delivery as-is, plus a
      // second clone dated for Sunday, so staff never have to separately dig
      // up and print the hidden Sunday record.
      const expanded = [];
      list.forEach((delivery) => {
        expanded.push(delivery);
        if (delivery?.combinedSunday?.scheduledTime) {
          const baseId = getDeliveryId(delivery);
          expanded.push({
            ...delivery,
            _id: `${baseId}-sunday`,
            id: `${baseId}-sunday`,
            scheduledTime: delivery.combinedSunday.scheduledTime,
            deliveryRecordId: delivery.combinedSunday.deliveryId,
            combinedSunday: null,
          });
        }
      });
      return expanded.sort((a, b) => {
        const timeA =
          a?.scheduledTime && !Number.isNaN(new Date(a.scheduledTime).getTime())
            ? new Date(a.scheduledTime).getTime()
            : Number.MAX_SAFE_INTEGER;
        const timeB =
          b?.scheduledTime && !Number.isNaN(new Date(b.scheduledTime).getTime())
            ? new Date(b.scheduledTime).getTime()
            : Number.MAX_SAFE_INTEGER;
        if (timeA !== timeB) return timeA - timeB;

        const nameA = (a?.customerName || '').trim().toLowerCase();
        const nameB = (b?.customerName || '').trim().toLowerCase();
        if (nameA !== nameB) return nameA.localeCompare(nameB);

        const zoneA = (a?.zone || '').trim().toLowerCase();
        const zoneB = (b?.zone || '').trim().toLowerCase();
        return zoneA.localeCompare(zoneB);
      });
    }, [deliveries]);

  const availableZones = useMemo(() => {
    const zones = new Set();
    safeDeliveries.forEach((delivery) => {
      if (delivery?.zone) {
        zones.add(delivery.zone);
      }
    });
    return Array.from(zones).sort((a, b) => a.localeCompare(b));
  }, [safeDeliveries]);

  const availableCompanies = useMemo(() => {
    const companies = new Set();
    safeDeliveries.forEach((delivery) => {
      if (delivery?.company) {
        companies.add(delivery.company);
      }
    });
    return Array.from(companies).sort((a, b) => a.localeCompare(b));
  }, [safeDeliveries]);

  const filteredDeliveries = useMemo(() => {
    let filtered = safeDeliveries;

    // Apply zone filter
    if (Array.isArray(config.excludedZones) && config.excludedZones.length > 0) {
      const excludedZonesSet = new Set(
        config.excludedZones.map((zone) => zone.trim().toLowerCase())
      );
      filtered = filtered.filter((delivery) => {
        const zone = (delivery?.zone || '').trim().toLowerCase();
        return !excludedZonesSet.has(zone);
      });
    }

    // Apply company filter
    if (Array.isArray(config.excludedCompanies) && config.excludedCompanies.length > 0) {
      const excludedCompaniesSet = new Set(
        config.excludedCompanies.map((company) => company.trim().toLowerCase())
      );
      filtered = filtered.filter((delivery) => {
        const company = (delivery?.company || '').trim().toLowerCase();
        return !excludedCompaniesSet.has(company);
      });
    }

    return filtered;
  }, [safeDeliveries, config.excludedZones, config.excludedCompanies]);

  useEffect(() => {
    setSelectedStickerIds((prev) => {
      const validIds = new Set(filteredDeliveries.map(getDeliveryId));
      const next = new Set();
      prev.forEach((id) => {
        if (validIds.has(id)) {
          next.add(id);
        }
      });
      return next;
    });
  }, [filteredDeliveries]);

  const arrangeDeliveries = (
    list,
    columns = 2,
    rowsPerColumn = 4,
    options = {}
  ) => {
    const { fillPlaceholders = false } = options;
    if (columns <= 1) {
      return [...list];
    }

    const arranged = [];
    const chunkSize = columns * rowsPerColumn;

    for (let start = 0; start < list.length; start += chunkSize) {
      const chunk = list.slice(start, start + chunkSize);
      
      // Create a 2D grid for visual layout
      const grid = Array.from({ length: rowsPerColumn }, () => 
        Array.from({ length: columns }, () => null)
      );

      // Fill COLUMN-BY-COLUMN (top to bottom within each column, left to right across columns)
      // Input: [A,B,C,D,E,F,G,H] with 2 columns, 4 rows
      // Results in grid:
      // [A, E]
      // [B, F]
      // [C, G]
      // [D, H]
      let index = 0;
      for (let col = 0; col < columns; col++) {
        for (let row = 0; row < rowsPerColumn; row++) {
          if (index < chunk.length) {
            grid[row][col] = chunk[index];
            index++;
          }
        }
      }

      // Read ROW-BY-ROW (left to right, top to bottom)
      // This gives us: [A, E, B, F, C, G, D, H]
      // CSS grid renders this with 2 columns left-to-right, top-to-bottom:
      // A | E
      // B | F
      // C | G
      // D | H
      for (let row = 0; row < rowsPerColumn; row++) {
        for (let col = 0; col < columns; col++) {
          const value = grid[row][col];
          if (value) {
            arranged.push(value);
          } else if (fillPlaceholders) {
            arranged.push(null);
          }
        }
      }
    }

    return arranged;
  };

  // Helper to calculate columns and rows based on config and paper size
  const getLayoutDimensions = () => {
    const paperSize = PAPER_SIZES[config.paperSize] || PAPER_SIZES.A4;
    const stickerWidth = config.stickerWidth || 100;
    const maxColumnsFit = Math.max(1, Math.floor(paperSize.width / stickerWidth));
    const printColumns = (config.autoFitColumns
      ? maxColumnsFit
      : Math.min(config.columns || maxColumnsFit, maxColumnsFit));
    const rowsPerColumn = config.rows || 1;
    
    return { printColumns, rowsPerColumn };
  };

  const { printColumns, rowsPerColumn } = getLayoutDimensions();

  const arrangedDeliveries = useMemo(
    () => arrangeDeliveries(filteredDeliveries, printColumns, rowsPerColumn),
    [filteredDeliveries, printColumns, rowsPerColumn]
  );

  const previewDeliveries = useMemo(
    () => arrangedDeliveries.slice(0, 6).map(buildStickerData),
    [arrangedDeliveries]
  );

  const driverLegend = useMemo(() => {
    const legend = new Map();
    filteredDeliveries.forEach((delivery) => {
      const data = buildStickerData(delivery);
      const key = delivery?.driver?._id || data.driverName || 'unassigned';
      if (!legend.has(key)) {
        legend.set(key, {
          name: data.driverName,
          color: data.driverColor,
        });
      }
    });
    return Array.from(legend.values());
  }, [filteredDeliveries]);

  const handleConfigChange = (key, value) => {
    setConfig((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleToggleField = (field) => {
    setConfig((prev) => ({
      ...prev,
      [field]: !prev[field],
    }));
  };

  const toggleExcludedZone = (zone) => {
    setConfig((prev) => {
      const current = new Set(prev.excludedZones || []);
      if (current.has(zone)) {
        current.delete(zone);
      } else {
        current.add(zone);
      }
      return { ...prev, excludedZones: Array.from(current) };
    });
  };

  const handleIncludeAllZones = () => {
    setConfig((prev) => ({ ...prev, excludedZones: [] }));
  };

  const handleExcludeAllZones = () => {
    setConfig((prev) => ({ ...prev, excludedZones: [...availableZones] }));
  };

  const toggleExcludedCompany = (company) => {
    setConfig((prev) => {
      const current = new Set(prev.excludedCompanies || []);
      if (current.has(company)) {
        current.delete(company);
      } else {
        current.add(company);
      }
      return { ...prev, excludedCompanies: Array.from(current) };
    });
  };

  const handleIncludeAllCompanies = () => {
    setConfig((prev) => ({ ...prev, excludedCompanies: [] }));
  };

  const handleExcludeAllCompanies = () => {
    setConfig((prev) => ({ ...prev, excludedCompanies: [...availableCompanies] }));
  };

  const toggleStickerSelection = (stickerId) => {
    setSelectedStickerIds((prev) => {
      const next = new Set(prev);
      if (next.has(stickerId)) {
        next.delete(stickerId);
      } else {
        next.add(stickerId);
      }
      return next;
    });
  };

  const clearStickerSelection = () => {
    setSelectedStickerIds(new Set());
  };

  const hasSelection = selectedStickerIds.size > 0;
  const selectionCount = selectedStickerIds.size;

    const buildStickerHtml = (delivery) => {
      if (!delivery) {
        return '<div class="sticker placeholder"></div>';
      }
      const data = buildStickerData(delivery);
    const bandStyle =
      config.driverColorMode === 'band'
        ? `background:${data.zoneColor};height:6px;`
        : '';

    const driverAccent =
      config.driverColorMode === 'badge'
        ? `<span class="driver-badge" style="background:${data.zoneColor};color:${data.zoneTextColor};">${escapeHtml(
            data.driverName
          )}</span>`
        : `<span class="driver-name">${escapeHtml(data.driverName)}</span>`;

    // Build top section with driver color box on the left and header + customer info on the right
    return `
      <div class="sticker ${config.borderStyle}">
        ${
          config.driverColorMode === 'band'
            ? `<div class="sticker-band" style="${bandStyle}"></div>`
            : ''
        }
        <div class="sticker-body" style="background:${config.backgroundColor};color:${config.textColor};border-color:${config.accentColor};">
          ${showLogo && logoDataUrl ? `<div style="width:100%;text-align:center;margin-bottom:6px;"><img src='${logoDataUrl}' alt='Logo' style='max-width:60px;max-height:40px;object-fit:contain;'/></div>` : ''}
          <div class="sticker-top">
            <div class="sticker-top-text">
              <div class="sticker-header" style="color:${config.accentColor};">
                ${escapeHtml(config.headerText)}
              </div>
              <div class="sticker-customer">
                <div class="customer-name">${escapeHtml(data.customerName)}</div>  
                ${
                  config.showDeliveryId && data.deliveryId
                    ? `<div class="delivery-id">ID: ${escapeHtml(data.deliveryId)}</div>`
                    : ''
                }
              </div>
              ${
            config.showAddress
              ? `<div class="sticker-field"><span>Address:</span> ${escapeHtml(
                  data.address
                )}</div>`
              : ''
          }
          ${
            config.showZone
              ? `<div class="sticker-field zone-row"><span>Zone:</span> <span class="zone-badge" style="background:${data.zoneColor};color:${data.zoneTextColor};">${escapeHtml(
                  data.zone
                )}</span></div>`
              : ''
          }
          ${
            config.showScheduledTime
              ? `<div class="sticker-field"><span>Time:</span> ${escapeHtml(
                  data.scheduledTime
                )}</div>`
              : ''
          }
          ${
            config.showCompany
              ? `<div class="sticker-field"><span>Company:</span> ${escapeHtml(
                  data.company
                )}</div>`
              : ''
          }
          ${
            config.showNotes && data.notes
              ? `<div class="sticker-notes">${escapeHtml(data.notes)}</div>`
              : ''
          }

            </div>
            <div class="driver-square">
              <div class="driver-square-inner" style="background:${data.zoneColor};"></div>
            </div>
          </div>
          
         
        </div>
         <div class="sticker-footer">${escapeHtml(config.footerText)}</div>
      </div>
    `;
  };

  const buildPrintMarkup = (deliveriesToPrint) => {
    // Use the same layout dimensions as preview
    const { printColumns, rowsPerColumn } = getLayoutDimensions();

    // Compute page + layout metrics
    const paperSize = PAPER_SIZES[config.paperSize] || PAPER_SIZES.A4;
    const stickerWidth = config.stickerWidth || 100;
    const stickerHeight = config.stickerHeight || 80;

    // Arrange deliveries using the calculated columns and rows
    const orderedDeliveries = arrangeDeliveries(
      deliveriesToPrint,
      printColumns,
      rowsPerColumn,
      {
        fillPlaceholders: true,
      }
    );

    // Build a single continuous grid so stickers flow naturally across pages
    const allStickersHtml = orderedDeliveries.map(buildStickerHtml).join('');

    const borderRadius =
      config.borderStyle === 'rounded'
        ? '12px'
        : config.borderStyle === 'pill'
        ? '32px'
        : '0px';

    // paperSize, stickerWidth, stickerHeight, printColumns already computed above

    return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Delivery Stickers</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @page {
          size: ${paperSize.width}mm ${paperSize.height}mm;
          margin: 0;
        }
        body { 
          font-family: 'Inter', Arial, sans-serif; 
          padding: 0;
          margin: 0;
          background: #fff; 
          color: #111827;
          width: ${paperSize.width}mm;
        }
        body, .sticker, .sticker-band, .driver-badge, .driver-square-inner {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
          color-adjust: exact;
        }
        .sticker-grid {
          display: grid;
          grid-template-columns: repeat(${printColumns}, ${stickerWidth}mm);
          gap: ${config.stickerMargin || 0}mm;
          justify-content: start;
        }
        .sticker {
          width: ${stickerWidth}mm;
          height: ${stickerHeight}mm;
          border: 1px solid ${config.accentColor};
          border-radius: ${borderRadius};
          overflow: hidden;
          page-break-inside: avoid;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          align-items: center;
        }
        .sticker.placeholder {
          visibility: hidden;
          border: none;
        }
  .sticker-body { position: relative; padding: 12px 14px; min-height: 140px; display:flex; flex-direction:column; }
        .sticker-top { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 6px; }
        .driver-square { flex: 0 0 85px; height: 61px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.1); display:flex; align-items:center; justify-content:center; background:#fff; }
        .driver-square-inner { width:82px; height:60px; border-radius:6px; }
        .sticker-top-text { flex:1; min-width:0; }
        .driver-inline { margin-top:4px; }
      .sticker-band {
        width: 100%;
      }
      .sticker-header {
        font-size: 0.8rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 6px;
      }
      .sticker-customer {
        margin-bottom: 6px;
      }
      .customer-name {
        font-size: 1rem;
        font-weight: 700;
      }
      .customer-id {
        font-size: 0.75rem;
        color: #6B7280;
      }
      .delivery-id {
        font-family: 'Courier New', monospace;
        font-size: 0.68rem;
        color: #374151;
        margin-top: 2px;
        word-break: break-all;
      }
      .sticker-field {
        font-size: 0.78rem;
        margin-bottom: 4px;
      }
      .sticker-field span {
        font-weight: 600;
        margin-right: 4px;
      }
      .zone-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .zone-badge { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px; font-weight:700; font-size:0.78rem; border:1px solid rgba(0,0,0,0.08); }
      .driver-badge {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 999px;
        color: #fff;
        font-size: 0.75rem;
        font-weight: 600;
      }
      .driver-name {
        font-weight: 700;
      }
      .sticker-notes {
        margin-top: 6px;
        padding: 4px 6px;
        background: rgba(0,0,0,0.04);
        border-radius: 6px;
        font-size: 0.75rem;
      }
      .sticker-footer {
        margin-top: auto; /* push footer to bottom */
        padding-bottom: 14px;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      @media print {
        body { 
          padding: 0;
          margin: 0;
        }
        .sticker-grid { 
          gap: ${config.stickerMargin || 0}mm;
        }
      }
    </style>
  </head>
  <body>
    <div class="sticker-grid">
      ${allStickersHtml}
    </div>
  </body>
</html>
`;
  };

  const handlePrint = () => {
    const sourceDeliveries = hasSelection
      ? filteredDeliveries.filter((delivery) =>
          selectedStickerIds.has(getDeliveryId(delivery))
        )
      : filteredDeliveries;

    if (!sourceDeliveries.length) {
      alert('No deliveries available for printing.');
      return;
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Pop-up blocked. Please allow pop-ups to print stickers.');
      return;
    }

    printWindow.document.write(buildPrintMarkup(sourceDeliveries));
    printWindow.document.close();
    printWindow.focus();
    printWindow.onload = () => {
      printWindow.print();
    };
  };

  const handleReset = () => {
    setConfig(DEFAULT_CONFIG);
    setSelectedStickerIds(new Set());
  };

  const handleSaveDesign = () => {
    localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify(config));
    alert('Sticker design saved. It will load automatically next time.');
  };

  // Lets a parent (e.g. PrintConfigModal) trigger printing synchronously from its own
  // click handler, using this instance's current config, without showing this
  // component's own designer UI (isOpen can stay false).
  useImperativeHandle(ref, () => ({ print: handlePrint }));

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 px-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col"
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
            <div>
              <h3 className="text-xl font-semibold text-gray-900">Sticker Designer</h3>
              <p className="text-sm text-gray-500">
                Configure and print stickers for {filteredDeliveries.length} deliveries
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-gray-100 text-gray-500"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
            <div className="space-y-6">
              <div className="border border-gray-100 rounded-xl p-4">
                <div className="flex items-center mb-4 space-x-2">
                  <Palette className="w-4 h-4 text-gray-500" />
                  <h4 className="text-sm font-semibold text-gray-700">Colors & Layout</h4>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500">Logo / Image</label>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={e => {
                        const file = e.target.files[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = ev => setLogoDataUrl(ev.target.result);
                          reader.readAsDataURL(file);
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-200 rounded mt-1 text-sm"
                    />
                    {logoDataUrl && (
                      <div className="mt-2 flex items-center gap-2">
                        <img src={logoDataUrl} alt="Logo preview" style={{ maxWidth: 60, maxHeight: 40, objectFit: 'contain', borderRadius: 6, border: '1px solid #eee' }} />
                        <button type="button" className="text-xs text-blue-600 underline" onClick={() => setLogoDataUrl(null)}>Remove</button>
                      </div>
                    )}
                    <label className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                      <input type="checkbox" checked={showLogo} onChange={e => setShowLogo(e.target.checked)} /> Show logo on stickers
                    </label>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Sticker Margin (mm)</label>
                    <input
                      type="number"
                      min="0"
                      max="20"
                      value={config.stickerMargin}
                      onChange={(e) => handleConfigChange('stickerMargin', Number(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-200 rounded mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Accent Color</label>
                    <input
                      type="color"
                      value={config.accentColor}
                      onChange={(e) => handleConfigChange('accentColor', e.target.value)}
                      className="w-full h-10 rounded border border-gray-200 mt-1 cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Text Color</label>
                    <input
                      type="color"
                      value={config.textColor}
                      onChange={(e) => handleConfigChange('textColor', e.target.value)}
                      className="w-full h-10 rounded border border-gray-200 mt-1 cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Background</label>
                    <input
                      type="color"
                      value={config.backgroundColor}
                      onChange={(e) =>
                        handleConfigChange('backgroundColor', e.target.value)
                      }
                      className="w-full h-10 rounded border border-gray-200 mt-1 cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 flex items-center space-x-1">
                      <Grid className="w-3 h-3" />
                      <span>Columns</span>
                    </label>
                    <div className="flex items-center justify-between mt-1">
                      <label className="text-xs text-gray-500 flex items-center space-x-2">
                        <input
                          type="checkbox"
                          className="rounded border-gray-300"
                          checked={config.autoFitColumns}
                          onChange={(e) => handleConfigChange('autoFitColumns', e.target.checked)}
                        />
                        <span>Auto-fit to page</span>
                      </label>
                      <span className="text-xs text-gray-500">
                        {config.autoFitColumns ? 'Auto' : `${config.columns} per row`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="6"
                      value={config.columns}
                      onChange={(e) =>
                        handleConfigChange('columns', Number(e.target.value))
                      }
                      className="w-full mt-2"
                      disabled={config.autoFitColumns}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {config.autoFitColumns
                        ? 'Will use the maximum that fits based on sticker width and paper size'
                        : `${config.columns} per row`}
                    </p>
                  </div>
                  
                  <div>
                    <label className="text-xs text-gray-500 flex items-center space-x-1">
                      <Grid className="w-3 h-3 rotate-90" />
                      <span>Rows</span>
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="6"
                      value={config.rows}
                      onChange={(e) =>
                        handleConfigChange('rows', Number(e.target.value))
                      }
                      className="w-full mt-2"
                    />
                    <p className="text-xs text-gray-500 mt-1">{config.rows} per page</p>
                  </div>
                </div>

                {/* Sticker Dimensions */}
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <label className="text-xs text-gray-500 font-semibold mb-3 block">
                    Sticker Dimensions (mm)
                  </label>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-gray-500">Width</label>
                      <input
                        type="number"
                        min="30"
                        max="200"
                        value={config.stickerWidth}
                        onChange={(e) =>
                          handleConfigChange('stickerWidth', Number(e.target.value))
                        }
                        className="w-full px-3 py-2 border border-gray-200 rounded mt-1 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500">Height</label>
                      <input
                        type="number"
                        min="30"
                        max="200"
                        value={config.stickerHeight}
                        onChange={(e) =>
                          handleConfigChange('stickerHeight', Number(e.target.value))
                        }
                        className="w-full px-3 py-2 border border-gray-200 rounded mt-1 text-sm"
                      />
                    </div>
                  </div>
                </div>

                {/* Paper Size Selection */}
                <div className="mt-4">
                  <label className="text-xs text-gray-500 font-semibold">Paper Size</label>
                  <select
                    value={config.paperSize}
                    onChange={(e) => handleConfigChange('paperSize', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded mt-2 text-sm"
                  >
                    {Object.entries(PAPER_SIZES).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value.label}
                      </option>
                    ))}
                  </select>
                  
                  {/* Layout Info */}
                  <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
                    <p className="text-xs text-blue-800 font-semibold mb-1">
                      Layout: {config.columns} × {config.rows} = {config.columns * config.rows} stickers per page
                    </p>
                    <p className="text-xs text-blue-600">
                      Each sticker: {config.stickerWidth} × {config.stickerHeight} mm
                    </p>
                    <p className="text-xs text-blue-600 mt-1">
                      ⏰ Stickers are grouped by scheduled time - each page will contain only one time slot
                    </p>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="text-xs text-gray-500">Driver Color Mode</label>
                  <div className="flex items-center space-x-3 mt-2">
                    {['band', 'badge'].map((mode) => (
                      <button
                        key={mode}
                        onClick={() => handleConfigChange('driverColorMode', mode)}
                        className={`px-3 py-1.5 rounded-lg text-sm ${
                          config.driverColorMode === mode
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {mode === 'band' ? 'Color Band' : 'Color Badge'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4">
                  <label className="text-xs text-gray-500">Border Style</label>
                  <div className="flex items-center space-x-3 mt-2">
                    {['rounded', 'square', 'pill'].map((style) => (
                      <button
                        key={style}
                        onClick={() => handleConfigChange('borderStyle', style)}
                        className={`px-3 py-1.5 rounded-lg text-sm ${
                          config.borderStyle === style
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {style.charAt(0).toUpperCase() + style.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {availableCompanies.length > 0 && (
                  <div className="mt-4">
                    <label className="text-xs text-gray-500">Exclude Companies</label>
                    <div className="flex items-center gap-2 text-xs mt-2">
                      <button
                        onClick={handleIncludeAllCompanies}
                        className="px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200"
                      >
                        Include all
                      </button>
                      <button
                        onClick={handleExcludeAllCompanies}
                        className="px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200"
                      >
                        Exclude all
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {availableCompanies.map((company) => (
                        <label
                          key={company}
                          className="flex items-center gap-2 text-xs text-gray-600 hover:bg-gray-50 p-2 rounded"
                        >
                          <input
                            type="checkbox"
                            className="rounded border-gray-300"
                            checked={!config.excludedCompanies?.includes(company)}
                            onChange={() => toggleExcludedCompany(company)}
                          />
                          <span>{company}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {availableZones.length > 0 && (
                  <div className="mt-4">
                    <label className="text-xs text-gray-500">Exclude Areas</label>
                    <div className="flex items-center gap-2 text-xs mt-2">
                      <button
                        onClick={handleIncludeAllZones}
                        className="px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200"
                      >
                        Include all
                      </button>
                      <button
                        onClick={handleExcludeAllZones}
                        className="px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200"
                      >
                        Exclude all
                      </button>
                    </div>
                    <div className="mt-3 border border-gray-100 rounded-lg max-h-32 overflow-y-auto divide-y divide-gray-100">
                      {availableZones.map((zone) => {
                        const excluded =
                          Array.isArray(config.excludedZones) &&
                          config.excludedZones.includes(zone);
                        return (
                          <label
                            key={zone}
                            className="flex items-center justify-between px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
                          >
                            <span>{zone}</span>
                            <input
                              type="checkbox"
                              checked={excluded}
                              onChange={() => toggleExcludedZone(zone)}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Checked areas will be excluded from stickers.
                    </p>
                  </div>
                )}
              </div>

              <div className="border border-gray-100 rounded-xl p-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">
                  Content
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { key: 'showDeliveryId', label: 'Delivery ID' },
                    { key: 'showCustomerId', label: 'Customer ID' },
                    { key: 'showAddress', label: 'Address' },
                    { key: 'showZone', label: 'Area / Zone' },
                    { key: 'showCompany', label: 'Company' },
                    { key: 'showScheduledTime', label: 'Scheduled Time' },
                    { key: 'showDriverName', label: 'Driver' },
                    { key: 'showNotes', label: 'Notes' },
                  ].map((item) => (
                    <label
                      key={item.key}
                      className="flex items-center space-x-2 text-sm text-gray-600"
                    >
                      <input
                        type="checkbox"
                        checked={config[item.key]}
                        onChange={() => handleToggleField(item.key)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-1 gap-3 mt-4">
                  <div>
                    <label className="text-xs text-gray-500">Header Text</label>
                    <input
                      type="text"
                      value={config.headerText}
                      onChange={(e) => handleConfigChange('headerText', e.target.value)}
                      className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Footer Text</label>
                    <input
                      type="text"
                      value={config.footerText}
                      onChange={(e) => handleConfigChange('footerText', e.target.value)}
                      className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button
                  onClick={handleReset}
                  className="inline-flex items-center px-3 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Reset design
                </button>
                <button
                  onClick={handleSaveDesign}
                  className="inline-flex items-center px-3 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                >
                  Save design
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-gray-700">
                    Preview ({previewDeliveries.length} of {filteredDeliveries.length})
                  </h4>
                  {hasSelection && (
                    <p className="text-xs text-gray-500">
                      {selectionCount} sticker{selectionCount === 1 ? '' : 's'} selected
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {hasSelection && (
                    <button
                      onClick={clearStickerSelection}
                      className="text-xs text-gray-500 hover:text-gray-700 underline"
                    >
                      Clear selection
                    </button>
                  )}
                  <button
                    onClick={handlePrint}
                    className="inline-flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                    disabled={!filteredDeliveries.length}
                  >
                    <Printer className="w-4 h-4 mr-2" />
                    {hasSelection ? `Print Selected (${selectionCount})` : 'Print Stickers'}
                  </button>
                </div>
              </div>

              <div className={`grid`} style={{ 
                gap: `${config.stickerMargin || 0}mm`,
                gridTemplateColumns: `repeat(${printColumns}, 1fr)`
              }}>
                {previewDeliveries.map((delivery) => {
                  const isSelected = selectedStickerIds.has(delivery.id);
                  return (
                    <div
                      key={delivery.id}
                      className={`border rounded-xl shadow-sm p-4 space-y-2 cursor-pointer transition ${
                        config.borderStyle === 'pill'
                          ? 'rounded-[32px]'
                          : config.borderStyle === 'square'
                          ? 'rounded-lg'
                          : 'rounded-2xl'
                      } ${isSelected ? 'ring-2 ring-indigo-500 border-indigo-500' : ''}`}
                      style={{
                        borderColor: config.accentColor,
                        backgroundColor: config.backgroundColor,
                        color: config.textColor,
                      }}
                      onClick={() => toggleStickerSelection(delivery.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleStickerSelection(delivery.id);
                        }
                      }}
                    >
                    {config.driverColorMode === 'band' && (
                      <div
                        className="h-1 w-full rounded-full mb-2"
                        style={{ backgroundColor: delivery.driverColor }}
                      />
                    )}
                    <div className="flex items-center justify-between">
                      <div
                        className="text-xs font-semibold uppercase tracking-wide"
                        style={{ color: config.accentColor }}
                      >
                        {config.headerText}
                      </div>
                      <input
                        type="checkbox"
                        readOnly
                        checked={isSelected}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 pointer-events-none"
                      />
                    </div>
                    <div>
                      <p className="text-base font-semibold">{delivery.customerName}</p>
                      {config.showDeliveryId && delivery.deliveryId && (
                        <p className="text-[11px] font-mono text-gray-600 break-all">ID: {delivery.deliveryId}</p>
                      )}
                      {config.showCustomerId && (
                        <p className="text-xs text-gray-500">ID: {delivery.customerId}</p>
                      )}
                    </div>
                    {config.showAddress && (
                      <p className="text-xs">
                        <span className="font-semibold">Address:</span> {delivery.address}
                      </p>
                    )}
                    {config.showZone && (
                      <p className="text-xs">
                        <span className="font-semibold">Zone:</span> {delivery.zone}
                      </p>
                    )}
                    {config.showScheduledTime && (
                      <p className="text-xs">
                        <span className="font-semibold">Time:</span> {delivery.scheduledTime}
                      </p>
                    )}
                    {config.showCompany && (
                      <p className="text-xs">
                        <span className="font-semibold">Company:</span> {delivery.company}
                      </p>
                    )}
                {config.showDriverName && (
                  <div className="text-xs font-semibold flex items-center space-x-2">
                    {config.driverColorMode === 'badge' ? (
                      <span
                        className="px-2 py-0.5 rounded-full text-white text-[11px]"
                        style={{ backgroundColor: delivery.driverColor }}
                      >
                        {delivery.driverName}
                      </span>
                    ) : (
                      <span>{delivery.driverName}</span>
                    )}
                  </div>
                )}
                <div className="flex justify-end mt-2">
                  <div
                    className="w-20 h-12 rounded-lg border border-gray-200"
                    style={{ backgroundColor: delivery.driverColor }}
                    title={`Driver color: ${delivery.driverColor}`}
                  />
                </div>
                    {config.showNotes && delivery.notes && (
                      <div className="text-[11px] bg-gray-100 rounded px-2 py-1">
                        {delivery.notes}
                      </div>
                    )}
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">
                      {config.footerText}
                    </p>
                    </div>
                  );
                })}

                {!previewDeliveries.length && (
                  <div className="col-span-2 h-40 border border-dashed border-gray-300 rounded-xl flex items-center justify-center text-gray-400">
                    No deliveries to preview
                  </div>
                )}
              </div>

              {driverLegend.length > 0 && (
                <div className="border border-gray-100 rounded-xl p-4">
                  <h4 className="text-sm font-semibold text-gray-700 mb-3">Driver colors</h4>
                  <div className="flex flex-wrap gap-3">
                    {driverLegend.map((driver) => (
                      <div
                        key={`${driver.name}-${driver.color}`}
                        className="flex items-center space-x-2 text-sm"
                      >
                        <span
                          className="w-10 h-6 rounded-md border border-gray-200"
                          style={{ backgroundColor: driver.color }}
                        />
                        <span className="text-gray-600">{driver.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
});

export default StickerDesignerModal;
