import { enrichSelectionsWithNutrition } from '../lib/kitchenData';
import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Edit,
  Trash2,
  AlertCircle,
  Loader,
  Eye,
  Calendar,
  Users,
  Upload,
  Download,
  Coffee,
  Sandwich,
  Cookie,
  X,
  Image as ImageIcon,
  FileText,
  PauseCircle
} from 'lucide-react';

// A meal's allergens are a small, bounded, real-world vocabulary — a chip
// picker (matching the design) fits it far better than a free-text field.
// (The much larger ingredient-exclusion list in constants/exclusionList.js
// stays a free-text/textarea field below — 170+ entries don't fit as chips.)
const ALLERGEN_OPTIONS = ['Gluten', 'Dairy', 'Eggs', 'Nuts', 'Peanuts', 'Soy', 'Fish', 'Shellfish', 'Sesame'];

// Display-only mirror of the fixed, company-wide policy the server actually
// enforces (server/config/selectionDeadlines.js) — the server applies this
// same table to every menu on create/update regardless of what's submitted,
// so this is shown for admin visibility only, never sent as editable input.
// Keep in sync with the server copy if the policy ever changes.
const FIXED_SELECTION_DEADLINES = [
  { deliveryDay: 'Monday', daysBefore: 3, deadlineTime: '15:00' },
  { deliveryDay: 'Tuesday', daysBefore: 2, deadlineTime: '00:00' },
  { deliveryDay: 'Wednesday', daysBefore: 2, deadlineTime: '00:00' },
  { deliveryDay: 'Thursday', daysBefore: 2, deadlineTime: '00:00' },
  { deliveryDay: 'Friday', daysBefore: 2, deadlineTime: '00:00' },
  { deliveryDay: 'Saturday', daysBefore: 3, deadlineTime: '00:00' },
  { deliveryDay: 'Sunday', daysBefore: 4, deadlineTime: '00:00' },
];
import api from '../utils/api';
import { loadKitchenSnapshot } from '../lib/kitchenSnapshot';
import { assertKitchenExportReady } from '../utils/kitchenIntegrity';
import { copyManagedMenuItem, managedMenuPayload } from '../utils/managedMenuItems';
import SupyRecipeSearch from '../components/SupyRecipeSearch';
import IngredientTagEditor from '../components/IngredientTagEditor';
import { toSentenceCase } from '../utils/textFormat';
import XLSX from 'xlsx-js-style';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

// Real fields only: isPublished / isActive / shareLink.isActive / startDate /
// endDate. There's no status enum on WeeklyMenu, so this derives one of
// Active / Scheduled / Stopped / Ended the same way a human would read those
// booleans + dates — no new schema field needed.
const getMenuStatus = (menu) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = menu.endDate ? new Date(menu.endDate) : null;
  if (end) end.setHours(0, 0, 0, 0);
  if (end && end < today) return 'Ended';
  if (!menu.isPublished) return 'Scheduled';
  if (menu.shareLink?.isActive === false) return 'Stopped';
  const start = menu.startDate ? new Date(menu.startDate) : null;
  if (start) start.setHours(0, 0, 0, 0);
  if (start && start > today) return 'Scheduled';
  return 'Active';
};

// Exact bg/fg pairing from the Design canvas file's own STATUS map (Active
// uses the green ramp, Stopped uses the blue/accent ramp — not red).
const MENU_STATUS_STYLE = {
  Active: 'bg-matter-accent2-300 text-matter-accent2-900',
  Scheduled: 'bg-matter-neutral-200 text-matter-neutral-800',
  Stopped: 'bg-matter-accent-200 text-matter-accent-800',
  Ended: 'bg-matter-neutral-200 text-matter-neutral-600',
};

const MENU_STATUS_TABS = ['All', 'Active', 'Scheduled', 'Stopped', 'Ended'];

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Per-day customer selection counts (quantity-aware) for the card's day
// strip, from menu.selectionsByDate — a raw {date, count} list the list
// endpoint aggregates from MenuSelectionRecord. Bucketed here by local date
// components (not the backend's, to avoid server/browser timezone drift).
const getMenuDayStrip = (menu) => {
  if (!menu.startDate) return [];
  const start = new Date(menu.startDate);
  start.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const count = (menu.selectionsByDate || []).reduce((sum, s) => {
      if (!s.date) return sum;
      const sd = new Date(s.date);
      return (sd.getFullYear() === d.getFullYear() && sd.getMonth() === d.getMonth() && sd.getDate() === d.getDate())
        ? sum + (s.count || 0)
        : sum;
    }, 0);
    days.push({ label: WEEKDAY_SHORT[d.getDay()], count });
  }
  return days;
};

const MenuManagement = () => {
  const [menus, setMenus] = useState([]);
  const [statusFilter, setStatusFilter] = useState('All');
  const [openActionsMenuId, setOpenActionsMenuId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedMenu, setSelectedMenu] = useState(null);
  const [copiedLink, setCopiedLink] = useState(null);
  const [weeklyItems, setWeeklyItems] = useState([]);
  const [selectionMenuId, setSelectionMenuId] = useState(null);
  const [menuSelections, setMenuSelections] = useState([]);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState(null);
  const [selectionSearch, setSelectionSearch] = useState('');
  const [selectionDates, setSelectionDates] = useState([]);
  const [uploadError, setUploadError] = useState(null);
  const [isUploadingMenu, setIsUploadingMenu] = useState(false);
  const [editingMenuId, setEditingMenuId] = useState(null);
  const [editingSlot, setEditingSlot] = useState(null); // { dayIndex, itemIndex } | null — the meal open in the slide-in editor
  const [copyDayMenuFor, setCopyDayMenuFor] = useState(null); // dayIndex | null — which day's "Copy from…" dropdown is open
  const [selectedCustomerDetail, setSelectedCustomerDetail] = useState(null);
  const [isDownloadingImage, setIsDownloadingImage] = useState(false);
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);
  const [isDownloadingKitchenPaper, setIsDownloadingKitchenPaper] = useState(false);
  const [isDownloadingMenuPDF, setIsDownloadingMenuPDF] = useState(false);
  const [isDownloadingMenuExcel, setIsDownloadingMenuExcel] = useState(false);
  const [isEditingSelections, setIsEditingSelections] = useState(false);
  const [editDraft, setEditDraft] = useState([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editMenuData, setEditMenuData] = useState(null); // full populated menu for edit mode
  const [editMenuLoading, setEditMenuLoading] = useState(false);
  const [editOpenSlot, setEditOpenSlot] = useState(null); // { dateKey, slotIndex, mealType } for open dropdown
  const [showPresetMacroModal, setShowPresetMacroModal] = useState(false);
  const [presetMacroForm, setPresetMacroForm] = useState({ breakfast: { C: '', P: '', F: '' }, snack: { C: '', P: '', F: '' } });
  const [savingPresetMacros, setSavingPresetMacros] = useState(false);
  const modalContentRef = useRef(null);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    startDate: '',
    endDate: '',
    mealPlans: ['Standard'],
    enableCompletionMessage: false,
    completionMessage: 'Your meal selections have been saved successfully.',
    selectionDeadlines: []
  });

  useEffect(() => {
    fetchMenus();
  }, []);

  const fetchMenus = async () => {
    try {
      setLoading(true);
      const response = await api.get('/menus');
      if (response.data?.success) {
        setMenus(response.data.data);
      }
    } catch (err) {
      console.error('Error fetching menus:', err);
      setError(err.response?.data?.message || 'Failed to fetch menus');
    } finally {
      setLoading(false);
    }
  };

  const getDateRange = (start, end) => {
    if (!start || !end) return [];
    const dates = [];
    
    // Parse date strings to avoid timezone issues
    // Date input returns "YYYY-MM-DD" which we need to parse in local timezone
    const parseDate = (dateString) => {
      const normalized = String(dateString).slice(0, 10);
      const [year, month, day] = normalized.split('-').map(Number);
      if (!year || !month || !day) return null;
      return new Date(year, month - 1, day);
    };
    
    const current = parseDate(start);
    const endDate = parseDate(end);
    if (!current || !endDate || Number.isNaN(current.getTime()) || Number.isNaN(endDate.getTime())) {
      return [];
    }
    current.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);

    // Include endDate by looping while current <= endDate
    while (current <= endDate) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  };

  // normalize various date representations to YYYY-MM-DD string
  const getDateKey = (value) => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    // use local date components to avoid timezone shifts
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Returns true when the selection deadline for a given day has passed.
  const isDateKeyLocked = (dateKey, deadlines) => {
    if (!dateKey) return false;
    const [year, month, day] = dateKey.split('-').map(Number);
    if (!year || !month || !day) return false;
    const deliveryDate = new Date(year, month - 1, day);

    // When no deadlines are configured, fall back to whether the date itself is in the past.
    if (!Array.isArray(deadlines) || deadlines.length === 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return deliveryDate < today;
    }

    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const deliveryDayName = DAY_NAMES[deliveryDate.getDay()];
    const rule = deadlines.find((d) => d.deliveryDay === deliveryDayName);
    if (!rule) {
      // No rule for this day — fall back to past-date check
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return deliveryDate < today;
    }
    const deadlineDateLocal = new Date(
      deliveryDate.getFullYear(),
      deliveryDate.getMonth(),
      deliveryDate.getDate() - (rule.daysBefore || 0)
    );
    const [hh, mm] = String(rule.deadlineTime || '23:59').split(':').map(Number);
    deadlineDateLocal.setHours(hh, mm, 59, 999);
    return new Date() > deadlineDateLocal;
  };

  // Returns the deadline Date object for a specific delivery day, or null if no rule.
  // Used to compare against a customer's submission time.
  const getDeadlineDate = (dateKey, deadlines) => {
    if (!dateKey) return null;
    const [year, month, day] = dateKey.split('-').map(Number);
    if (!year || !month || !day) return null;
    const deliveryDate = new Date(year, month - 1, day);

    if (!Array.isArray(deadlines) || deadlines.length === 0) {
      // No deadlines configured — treat start-of-day as deadline
      const d = new Date(year, month - 1, day);
      d.setHours(0, 0, 0, 0);
      return d;
    }

    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const deliveryDayName = DAY_NAMES[deliveryDate.getDay()];
    const rule = deadlines.find((d) => d.deliveryDay === deliveryDayName);
    if (!rule) {
      const d = new Date(year, month - 1, day);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const deadlineDateLocal = new Date(
      deliveryDate.getFullYear(),
      deliveryDate.getMonth(),
      deliveryDate.getDate() - (rule.daysBefore || 0)
    );
    const [hh, mm] = String(rule.deadlineTime || '23:59').split(':').map(Number);
    deadlineDateLocal.setHours(hh, mm, 59, 999);
    return deadlineDateLocal;
  };

  // Human-readable status for a day the customer skipped, including whether the
  // Matter website pause was applied (or the error). Used in the STATUS column
  // of the selections Excel export and the on-screen detail view.
  const formatSkipStatus = (skip) => {
    if (!skip) return null;
    switch (skip.pauseStatus) {
      case 'success':
        return `Skipped — pause applied on Matter${skip.resumeDate ? ` (resumes ${skip.resumeDate})` : ''}`;
      case 'already_paused':
        return 'Skipped — already paused on Matter';
      case 'pending':
        return 'Skipped — pause pending on Matter';
      case 'failed':
        return `Skipped — pause FAILED on Matter: ${skip.error || 'Unknown error'}`;
      default:
        return 'Skipped';
    }
  };

  const getSkipForDate = (customer, dateKey) =>
    (customer?.skippedDays || []).find((s) => String(s.date || '').slice(0, 10) === dateKey) || null;

  const initializeWeeklyItems = (start, end) => {
    const dates = getDateRange(start, end);
    return dates.map((date) => ({ date: getDateKey(date), items: [] }));
  };

  const handleWeeklyItemChange = (dayIndex, itemIndex, field, value) => {
    setWeeklyItems((prev) => {
      const updated = [...prev];
      updated[dayIndex] = { ...updated[dayIndex] };
      updated[dayIndex].items = [...updated[dayIndex].items];
      updated[dayIndex].items[itemIndex] = {
        ...updated[dayIndex].items[itemIndex],
        [field]: value
      };
      return updated;
    });
  };

  // Adds a blank meal to the day and immediately opens it in the slide-in
  // editor — matches the design's "+ Meal" → editor-opens-on-the-new-item flow.
  const handleAddItemForDay = (dayIndex) => {
    const newIndex = weeklyItems[dayIndex]?.items.length || 0;
    setWeeklyItems((prev) => {
      const updated = [...prev];
      updated[dayIndex] = { ...updated[dayIndex] };
      updated[dayIndex].items = [
        ...updated[dayIndex].items,
        {
          mealType: 'main',
          mealName: '',
          ingredients: '',
          proteinSource: '',
          category: '',
          intolerances: '',
          allergens: '',
          garnish: '',
          carbs: '',
          veg: '',
          sauce: '',
          portionIngredients: [],
          carbIngredients: [],
          vegIngredients: [],
          sauceIngredients: [],
          portionType: '',
          rotationCategory: '',
          usedForCorePlan: false,
          price: 0
        }
      ];
      return updated;
    });
    setEditingSlot({ dayIndex, itemIndex: newIndex });
  };

  const handleRemoveItemForDay = (dayIndex, itemIndex) => {
    setWeeklyItems((prev) => {
      const updated = [...prev];
      updated[dayIndex] = { ...updated[dayIndex] };
      updated[dayIndex].items = updated[dayIndex].items.filter((_, idx) => idx !== itemIndex);
      return updated;
    });
    setEditingSlot(null);
  };

  const handleDuplicateItem = (dayIndex, itemIndex) => {
    const newIndex = weeklyItems[dayIndex]?.items.length || 0;
    setWeeklyItems((prev) => {
      const updated = [...prev];
      updated[dayIndex] = { ...updated[dayIndex] };
      const source = updated[dayIndex].items[itemIndex];
      updated[dayIndex].items = [
        ...updated[dayIndex].items,
        { ...copyManagedMenuItem(source), mealName: source.mealName ? `${source.mealName} (copy)` : '' }
      ];
      return updated;
    });
    setEditingSlot({ dayIndex, itemIndex: newIndex });
  };

  // Copies every meal (breakfast, main, snack — whatever that day has) from
  // one day onto another, e.g. "make Sunday the same as Saturday". Appends
  // to whatever's already on the target day rather than replacing it, so
  // duplicating twice — or onto a day that already has something planned —
  // never silently deletes existing meals.
  const handleDuplicateDay = (sourceDayIndex, targetDayIndex) => {
    setWeeklyItems((prev) => {
      const source = prev[sourceDayIndex];
      if (!source || source.items.length === 0) return prev;
      const updated = [...prev];
      updated[targetDayIndex] = {
        ...updated[targetDayIndex],
        items: [...updated[targetDayIndex].items, ...source.items.map(copyManagedMenuItem)]
      };
      return updated;
    });
    setCopyDayMenuFor(null);
  };

  // 'lunch'/'dinner' were merged into a single 'main' meal type — old CSV
  // templates, saved menus, and pasted data may still carry either literal,
  // so every mealType read normalizes them here rather than trusting the enum.
  const normalizeMealType = (value) => {
    const t = String(value || '').trim().toLowerCase();
    if (t === 'lunch' || t === 'dinner') return 'main';
    if (t === 'breakfast' || t === 'snack') return t;
    return 'main';
  };

  const MEAL_TYPE_LABELS = { main: 'Main Meal', breakfast: 'Breakfast', snack: 'Snack' };
  const mealTypeLabel = (value) => MEAL_TYPE_LABELS[normalizeMealType(value)];

  const normalizeHeader = (value) => String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

  const getHeaderIndex = (headers, candidates) => {
    const normalized = headers.map(normalizeHeader);
    for (const candidate of candidates) {
      const idx = normalized.indexOf(normalizeHeader(candidate));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  // Column layout shared by the blank template and the "Download Excel" of an
  // existing menu. SLOT / PROTEIN TYPE / SAUCE / GARNISH sit at the end so
  // files made before they existed still parse by position (see the fallback
  // order in upload). SAUCE and GARNISH are never shown to the customer — the
  // selection screen only uses them to flag a swap to the kitchen (see
  // needsSauceChange/needsGarnishChange, surfaced on Kitchen List as "Change
  // sauce"/"Change garnish") when they hit a customer's exclusion.
  const MENU_EXCEL_HEADERS = [
    'MEAL TYPE', 'INTOLERANCES', 'DAY', 'MEAL NAME', 'CARB', 'VEG', 'SLOT', 'PROTEIN TYPE', 'SAUCE', 'GARNISH'
  ];
  const SLOT_VALUES = ['main', 'sub'];
  const PROTEIN_TYPE_VALUES = ['chicken', 'beef', 'fish'];
  const normalizeSlot = (value) => {
    const v = String(value || '').trim().toLowerCase();
    return SLOT_VALUES.includes(v) ? v : '';
  };
  const normalizeProteinType = (value) => {
    const v = String(value || '').trim().toLowerCase();
    return PROTEIN_TYPE_VALUES.includes(v) ? v : '';
  };

  const writeMenuExcel = (rows, fileName) => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([MENU_EXCEL_HEADERS, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Menu Upload');
    XLSX.writeFile(wb, fileName);
  };

  const handleDownloadMenuTemplate = () => {
    writeMenuExcel(
      [
        ['main', 'nuts, dairy', 1, 'Chicken Bowl', 'rice', 'broccoli', 'main', 'chicken', 'teriyaki sauce', 'sesame seeds'],
        ['main', 'gluten', 2, 'Beef Stew', 'quinoa', 'spinach', 'sub', 'beef', 'tomato sauce', 'parsley'],
        ['snack', '', 1, 'Mixed Nuts Pack', '', '', '', '', '', '']
      ],
      'menu_upload_template.xlsx'
    );
  };

  // Excel copy of an existing menu, in the same layout as the upload template,
  // so it can be edited offline and re-uploaded. Snacks are included here
  // because they are part of the menu's data (kitchen), even though they are
  // not shown on the printed/customer menu.
  const handleDownloadMenuExcel = async (menu) => {
    if (!menu) return;
    try {
      setIsDownloadingMenuExcel(true);
      const response = await api.get(`/menus/${menu._id}`);
      if (!response.data?.success) {
        throw new Error(response.data?.message || 'Failed to load menu details');
      }
      const menuData = response.data.data;
      const startKey = menuData.startDate ? getDateKey(menuData.startDate) : null;
      const startMs = startKey ? new Date(`${startKey}T00:00:00`).getTime() : null;

      const rows = [];
      buildWeeklyItemsFromMenu(menuData).forEach((day) => {
        const dayMs = new Date(`${day.date}T00:00:00`).getTime();
        const dayNumber = startMs !== null ? Math.round((dayMs - startMs) / 86400000) + 1 : '';
        day.items.forEach((item) => {
          rows.push([
            item.mealType,
            item.intolerances,
            dayNumber,
            item.mealName,
            item.carbs,
            item.veg,
            normalizeSlot(item.rotationCategory),
            normalizeProteinType(item.portionType),
            item.sauce,
            item.garnish
          ]);
        });
      });

      if (!rows.length) {
        alert('No menu items found to download.');
        return;
      }
      const safeTitle = String(menuData.title || 'menu').replace(/[^a-z0-9-_]+/gi, '_');
      writeMenuExcel(rows, `${safeTitle}-menu.xlsx`);
    } catch (error) {
      console.error('Menu Excel download error:', error);
      alert(error.message || 'Failed to download menu Excel.');
    } finally {
      setIsDownloadingMenuExcel(false);
    }
  };

  const handleMenuUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!formData.startDate) {
      setUploadError('Please set a start date before uploading the menu file.');
      event.target.value = '';
      return;
    }

    try {
      setIsUploadingMenu(true);
      setUploadError(null);

      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });

      if (!rows.length) {
        throw new Error('The file is empty.');
      }

      const headerRow = rows[0] || [];
      const headerIndexes = {
        mealType: getHeaderIndex(headerRow, ['MEAL TYPE', 'TYPE', 'MEALTYPE']),
        intolerances: getHeaderIndex(headerRow, ['INTOLERANCES', 'INTOLERANCE', 'EXCLUSIONS', 'EXCLUSION']),
        day: getHeaderIndex(headerRow, ['DAY', 'DAY NUMBER', 'DAY#']),
        mealName: getHeaderIndex(headerRow, ['MEAL NAME', 'MEAL', 'NAME', 'MEALNAME']),
        carb: getHeaderIndex(headerRow, ['CARB', 'CARBS']),
        veg: getHeaderIndex(headerRow, ['VEG', 'VEGETABLE', 'VEGGIE']),
        slot: getHeaderIndex(headerRow, ['SLOT']),
        proteinType: getHeaderIndex(headerRow, ['PROTEIN TYPE', 'PROTEIN', 'PORTION TYPE']),
        sauce: getHeaderIndex(headerRow, ['SAUCE']),
        garnish: getHeaderIndex(headerRow, ['GARNISH'])
      };

      const useFallbackOrder =
        headerIndexes.day === -1 ||
        headerIndexes.mealName === -1;

      const baseDate = new Date(formData.startDate);
      if (Number.isNaN(baseDate.getTime())) {
        throw new Error('Invalid start date.');
      }

      const dayMap = new Map();
      const dataRows = rows.slice(1);

      dataRows.forEach((row) => {
        const values = Array.isArray(row) ? row : [];

        const mealType = useFallbackOrder ? values[0] : values[headerIndexes.mealType];
        const intolerances = useFallbackOrder ? values[1] : values[headerIndexes.intolerances];
        const dayValue = useFallbackOrder ? values[2] : values[headerIndexes.day];
        const mealName = useFallbackOrder ? values[3] : values[headerIndexes.mealName];
        const carb = useFallbackOrder ? values[4] : values[headerIndexes.carb];
        const veg = useFallbackOrder ? values[5] : values[headerIndexes.veg];
        // Positional fallback is only safe for the original 6 columns; the new
        // ones are read by header, or by position 6/7 in a headed file that
        // doesn't name them.
        const slot = headerIndexes.slot !== -1 ? values[headerIndexes.slot] : values[6];
        const proteinType = headerIndexes.proteinType !== -1 ? values[headerIndexes.proteinType] : values[7];
        // Never shown to the customer (see MENU_EXCEL_HEADERS comment above) —
        // only used to flag a kitchen swap when they hit an exclusion.
        const sauce = headerIndexes.sauce !== -1 ? values[headerIndexes.sauce] : values[8];
        const garnish = headerIndexes.garnish !== -1 ? values[headerIndexes.garnish] : values[9];

        const dayNumber = Number.parseInt(String(dayValue || '').trim(), 10);
        if (!mealName || Number.isNaN(dayNumber) || dayNumber <= 0) {
          return;
        }

        const itemDate = new Date(baseDate);
        itemDate.setDate(itemDate.getDate() + (dayNumber - 1));
        const dateKey = getDateKey(itemDate);

        if (!dayMap.has(dateKey)) {
          dayMap.set(dateKey, {
            date: dateKey,
            items: []
          });
        }

        const mealTypeNormalized = normalizeMealType(mealType);
        // Slot (main/sub) and protein type (chicken/beef/fish) drive the main-meal
        // rotation; snacks don't take part in it, so they're saved without them.
        const isSnack = mealTypeNormalized === 'snack';
        dayMap.get(dateKey).items.push({
          mealType: mealTypeNormalized,
          mealName: String(mealName).trim(),
          ingredients: '',
          intolerances: String(intolerances || '').trim(),
          allergens: '',
          carbs: String(carb || '').trim(),
          veg: String(veg || '').trim(),
          rotationCategory: isSnack ? '' : normalizeSlot(slot),
          portionType: isSnack ? '' : normalizeProteinType(proteinType),
          sauce: String(sauce || '').trim(),
          garnish: String(garnish || '').trim()
        });
      });

      if (dayMap.size === 0) {
        throw new Error('No valid rows found. Please check the template format.');
      }

      const uploadedItems = Array.from(dayMap.values()).sort((a, b) =>
        a.date.localeCompare(b.date)
      );

      setWeeklyItems(uploadedItems);
    } catch (uploadErr) {
      console.error('Menu upload error:', uploadErr);
      setUploadError(uploadErr.message || 'Failed to parse menu file.');
    } finally {
      setIsUploadingMenu(false);
      event.target.value = '';
    }
  };

  // Re-initialise the empty week only when the dates change. Depending on
  // weeklyItems.length here meant that uploading a file covering fewer days than
  // the range (e.g. only day 1 of a 2-day range) changed the length and wiped the
  // uploaded items straight after the upload.
  useEffect(() => {
    if (formData.startDate && formData.endDate) {
      if (editingMenuId && weeklyItems.length > 0) return;
      setWeeklyItems(initializeWeeklyItems(formData.startDate, formData.endDate));
    }
  }, [formData.startDate, formData.endDate, editingMenuId]);

  const closeCreateForm = () => {
    setShowCreateForm(false);
    setEditingMenuId(null);
    setEditingSlot(null);
    setUploadError(null);
    setFormData({
      title: '',
      description: '',
      startDate: '',
      endDate: '',
      mealPlans: ['Standard'],
      enableCompletionMessage: false,
      completionMessage: 'Your meal selections have been saved successfully.',
      selectionDeadlines: []
    });
    setWeeklyItems([]);
  };

  // publish=false → save/update as a draft (matches the design's "Save draft").
  // publish=true → save, then publish, then copy the share link — presented
  // as one action ("Publish & copy link"), same as the design's button.
  const handleSaveMenu = async ({ publish }) => {
    try {
      const payload = managedMenuPayload(formData, weeklyItems, publish);
      let response = editingMenuId
        ? await api.put(`/menus/${editingMenuId}`, payload)
        : await api.post('/menus', payload);

      if (!response.data?.success) {
        setError(response.data?.message || 'Failed to save menu');
        return;
      }
      let savedMenu = response.data.data;

      setMenus((prev) => {
        const exists = prev.some((m) => m._id === savedMenu._id);
        return exists ? prev.map((m) => (m._id === savedMenu._id ? savedMenu : m)) : [savedMenu, ...prev];
      });

      if (publish && savedMenu.shareLink?.token) {
        const shareUrl = `${window.location.origin}/menu-select/${savedMenu.shareLink.token}`;
        try { await navigator.clipboard.writeText(shareUrl); } catch (clipErr) { /* clipboard may be unavailable — link is still saved */ }
      }

      closeCreateForm();
      if (response.data.warnings?.length) setError(response.data.warnings.join(' '));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save menu');
    }
  };

  const buildWeeklyItemsFromMenu = (menu) => {
    const dayMap = new Map();
    const meals = Array.isArray(menu?.meals) ? menu.meals : [];

    meals.forEach((meal) => {
      const dateKey = meal?.date ? getDateKey(meal.date) : null;
      if (!dateKey) return;

      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, { date: dateKey, items: [] });
      }

      const items = Array.isArray(meal.items) ? meal.items : [];
      items.forEach((item) => {
        if (!item) return;
        dayMap.get(dateKey).items.push({
          menuItemId: item._id || '',
          mealType: normalizeMealType(meal.mealType || item.mealType),
          mealName: item.mealName || '',
          ingredients: item.ingredients || '',
          proteinSource: item.proteinSource || '',
          category: item.category || '',
          intolerances: item.intolerances || '',
          allergens: Array.isArray(item.allergens) ? item.allergens.join(', ') : (item.allergens || ''),
          garnish: item.garnish || '',
          carbs: item.carbs || '',
          veg: item.veg || '',
          sauce: item.sauce || '',
          portionIngredients: Array.isArray(item.portionIngredients) ? item.portionIngredients : [],
          carbIngredients: Array.isArray(item.carbIngredients) ? item.carbIngredients : [],
          vegIngredients: Array.isArray(item.vegIngredients) ? item.vegIngredients : [],
          sauceIngredients: Array.isArray(item.sauceIngredients) ? item.sauceIngredients : [],
          portionType: item.portionType || '',
          rotationCategory: item.rotationCategory || '',
          usedForCorePlan: !!item.usedForCorePlan
        });
      });
    });

    return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  };

  const handleEditMenu = async (menuId) => {
    try {
      const response = await api.get(`/menus/${menuId}`);
      if (!response.data?.success) return;

      const menu = response.data.data;
      setEditingMenuId(menuId);
      setShowCreateForm(true);
      setUploadError(null);
      setFormData({
        title: menu.title || '',
        expectedUpdatedAt: menu.updatedAt,
        description: menu.description || '',
        startDate: menu.startDate ? getDateKey(menu.startDate) : '',
        endDate: menu.endDate ? getDateKey(menu.endDate) : '',
        mealPlans: menu.mealPlans && menu.mealPlans.length ? menu.mealPlans : ['Standard'],
        enableCompletionMessage: menu.enableCompletionMessage || false,
        completionMessage: menu.completionMessage || 'Your meal selections have been saved successfully.',
        selectionDeadlines: menu.selectionDeadlines || []
      });
      // Seed every day in the range (even ones with no meals yet) so the
      // day-grid always shows all 7 columns, not just the days that already
      // have items.
      const fullRange = getDateRange(menu.startDate, menu.endDate).map((d) => ({ date: getDateKey(d), items: [] }));
      const builtByDate = new Map(buildWeeklyItemsFromMenu(menu).map((d) => [d.date, d.items]));
      setWeeklyItems(fullRange.map((d) => ({ date: d.date, items: builtByDate.get(d.date) || [] })));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load menu for editing');
    }
  };

  const handlePublishMenu = async (menuId) => {
    try {
      const response = await api.put(`/menus/${menuId}`, {
        isPublished: true
      });

      if (response.data?.success) {
        setMenus(menus.map(m => m._id === menuId ? response.data.data : m));
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to publish menu');
    }
  };

  const handleDeleteMenu = async (menuId) => {
    if (!window.confirm('Are you sure you want to delete this menu?')) return;

    try {
      await api.delete(`/menus/${menuId}`);
      setMenus(menus.filter(m => m._id !== menuId));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete menu');
    }
  };

  const handleDeleteCustomerSelection = async (menuId, customer) => {
    const name = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customer.email;
    if (!window.confirm(`Delete meal selection for ${name}?`)) return;

    try {
      await api.delete(`/menus/${menuId}/selections/${encodeURIComponent(customer.email)}`);
      setMenuSelections(prev => prev.filter(c => c.email !== customer.email));
      setMenus(prev => prev.map(m =>
        m._id === menuId ? { ...m, selectionCount: Math.max(0, (m.selectionCount || 1) - 1) } : m
      ));
      if (selectedCustomerDetail?.email === customer.email) {
        setSelectedCustomerDetail(null);
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to delete selection');
    }
  };

  const getShareLink = async (menuId) => {
    try {
      const response = await api.get(`/menus/${menuId}/share-link`);
      if (response.data?.success) {
        return response.data.data.shareUrl;
      }
    } catch (err) {
      console.error('Error getting share link:', err);
    }
  };

  const copyShareLink = async (menuId) => {
    const shareUrl = await getShareLink(menuId);
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
      setCopiedLink(menuId);
      setTimeout(() => setCopiedLink(null), 2000);
    }
  };

  const handleToggleShareLink = async (menuId, isCurrentlyActive) => {
    try {
      const response = await api.put(`/menus/${menuId}`, {
        shareLinkActive: !isCurrentlyActive
      });

      if (response.data?.success) {
        setMenus(menus.map(m => m._id === menuId ? response.data.data : m));
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update link status');
    }
  };

  const handleViewSelections = async (menuId) => {
    if (selectionMenuId === menuId) {
      setSelectionMenuId(null);
      setMenuSelections([]);
      setSelectionError(null);
      return;
    }

    try {
      setSelectionLoading(true);
      setSelectionError(null);
      setSelectionMenuId(menuId);
      setSelectionSearch('');

      // calculate date range for the selected menu
      const menu = menus.find(m => m._id === menuId);
      if (menu) {
        setSelectionDates(getDateRange(menu.startDate, menu.endDate));
      } else {
        setSelectionDates([]);
      }

      const response = await api.get(`/menus/${menuId}/selections`);
      if (response.data?.success) {
        const data = await enrichSelectionsWithNutrition(api, response.data.data || [], { current: new Map() }, { extended: true });
        setMenuSelections(data);
        // Update the menu card's selectionCount in local state so the badge stays accurate
        setMenus(prev => prev.map(m =>
          m._id === menuId ? { ...m, selectionCount: data.length } : m
        ));
      } else {
        setSelectionError(response.data?.message || 'Failed to load selections');
      }
    } catch (err) {
      setSelectionError(err.response?.data?.message || 'Failed to load selections');
    } finally {
      setSelectionLoading(false);
    }
  };

  const handleDownloadMenuPDF = async (menu) => {
    if (!menu) return;

    try {
      setIsDownloadingMenuPDF(true);
      const response = await api.get(`/menus/${menu._id}`);
      if (!response.data?.success) {
        throw new Error(response.data?.message || 'Failed to load menu details');
      }

      const menuData = response.data.data;
      const weeklyItems = buildWeeklyItemsFromMenu(menuData);
      if (!weeklyItems.length) {
        alert('No menu items found to download.');
        return;
      }

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = 210;
      const pageHeight = 297;
      const margin = 15;
      const maxWidth = pageWidth - margin * 2;
      let currentY = margin;

      const safeTitle = String(menuData.title || 'Menu').replace(/[^a-z0-9-_]+/gi, '_');
      const formatMenuDayLabel = (dateKey) => {
        if (dateKey === 'ALL_DAYS') return 'All Days';
        const date = new Date(dateKey);
        if (Number.isNaN(date.getTime())) return dateKey;
        return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
      };

      const addTextLines = (text, x, y, lineHeight = 6) => {
        const lines = pdf.splitTextToSize(text, maxWidth);
        pdf.text(lines, x, y);
        return lines.length * lineHeight;
      };

      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      pdf.text(menuData.title || 'Weekly Menu', margin, currentY);
      currentY += 10;

      if (menuData.description) {
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'normal');
        currentY += addTextLines(menuData.description, margin, currentY, 5);
        currentY += 4;
      }

      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      const dateRange = `${menuData.startDate ? new Date(menuData.startDate).toLocaleDateString() : 'N/A'} - ${menuData.endDate ? new Date(menuData.endDate).toLocaleDateString() : 'N/A'}`;
      pdf.text(`Date range: ${dateRange}`, margin, currentY);
      currentY += 6;

      if (Array.isArray(menuData.mealPlans) && menuData.mealPlans.length) {
        pdf.text(`Meal plan: ${menuData.mealPlans.join(', ')}`, margin, currentY);
        currentY += 8;
      } else {
        currentY += 4;
      }

      weeklyItems.forEach((day) => {
        if (currentY > pageHeight - margin - 30) {
          pdf.addPage();
          currentY = margin;
        }

        pdf.setFontSize(14);
        pdf.setFont('helvetica', 'bold');
        pdf.text(formatMenuDayLabel(day.date), margin, currentY);
        currentY += 8;

        // Snacks stay in the database for the kitchen list only — they are not
        // part of the menu the customer/printed menu shows.
        const menuFacingItems = (day.items || []).filter((item) => item.mealType !== 'snack');
        if (menuFacingItems.length === 0) {
          pdf.setFontSize(10);
          pdf.setFont('helvetica', 'normal');
          pdf.text('No items listed for this day.', margin + 2, currentY);
          currentY += 8;
        } else {
          menuFacingItems.forEach((item) => {
            if (currentY > pageHeight - margin - 40) {
              pdf.addPage();
              currentY = margin;
            }

            pdf.setFontSize(11);
            pdf.setFont('helvetica', 'bold');
            const titleText = `${item.mealType ? `${item.mealType}` : 'Meal'}${item.mealName ? ` - ${item.mealName}` : ''}`;
            currentY += addTextLines(titleText, margin, currentY, 6);

            const addLineValue = (label, value) => {
              if (!value) return;
              currentY += addTextLines(`${label}: ${value}`, margin + 2, currentY, 5);
            };

            addLineValue('Category', item.category);
            addLineValue('Ingredients', item.ingredients);
            addLineValue('Protein', item.proteinSource);
            addLineValue('Intolerances', item.intolerances);
            addLineValue('Allergens', item.allergens);
            addLineValue('Garnish', item.garnish);
            addLineValue('CARB', item.carbs);
            addLineValue('VEG', item.veg);
            addLineValue('Sauce', item.sauce);
            currentY += 4;
          });
        }

        currentY += 4;
      });

      pdf.save(`${safeTitle}-menu.pdf`);
    } catch (err) {
      console.error('Error generating menu PDF:', err);
      alert(err.message || 'Failed to download menu PDF');
    } finally {
      setIsDownloadingMenuPDF(false);
    }
  };

  const handleDownloadAsImage = async () => {
    if (!modalContentRef.current || !selectedCustomerDetail) return;
    
    try {
      setIsDownloadingImage(true);
      
      // Find the scrollable body element
      const scrollBody = modalContentRef.current.querySelector('[style*="overflow-y-auto"]');
      
      let canvas;
      
      if (scrollBody) {
        const originalMaxHeight = scrollBody.style.maxHeight;
        const originalOverflow = scrollBody.style.overflow;
        
        // Scroll to bottom to ensure all content is rendered
        scrollBody.scrollTop = scrollBody.scrollHeight;
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Get the full height needed
        const fullHeight = scrollBody.scrollHeight;
        
        // Temporarily expand the container to show all content
        scrollBody.style.maxHeight = `${fullHeight + 100}px`;
        scrollBody.style.overflow = 'visible';
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Capture the full modal - html2canvas returns the canvas directly
        canvas = await html2canvas(modalContentRef.current, {
          scale: 2,
          backgroundColor: '#ffffff',
          logging: false,
          useCORS: true,
          allowTaint: true,
          imageTimeout: 0,
          onclone: (clonedDoc) => {
            // Force all elements in the clone to display fully
            const allElements = clonedDoc.querySelectorAll('*');
            allElements.forEach(el => {
              el.style.overflow = 'visible !important';
              el.style.maxHeight = 'none !important';
              el.style.height = 'auto !important';
            });
          }
        });
        
        // Restore original styles
        scrollBody.style.maxHeight = originalMaxHeight;
        scrollBody.style.overflow = originalOverflow;
        scrollBody.scrollTop = 0;
      } else {
        // Fallback if we can't find the scroll container
        canvas = await html2canvas(modalContentRef.current, {
          scale: 2,
          backgroundColor: '#ffffff',
          logging: false,
          useCORS: true,
          allowTaint: true
        });
      }
      
      // Convert canvas to JPEG and download
      const imageData = canvas.toDataURL('image/jpeg', 0.95);
      
      const link = document.createElement('a');
      const customerName = `${selectedCustomerDetail.firstName || ''} ${selectedCustomerDetail.lastName || ''}`.trim() || 'Customer';
      const fileName = `${customerName.replace(/[^a-zA-Z0-9]/g, '_')}_Selections_${new Date().toISOString().split('T')[0]}.jpg`;
      
      link.download = fileName;
      link.href = imageData;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
    } catch (error) {
      console.error('Error generating image:', error);
      alert('Failed to generate image. Please try again.');
    } finally {
      setIsDownloadingImage(false);
    }
  };

  const handleDownloadAsPDF = async () => {
    if (!modalContentRef.current || !selectedCustomerDetail) return;
    
    try {
      setIsDownloadingPDF(true);
      
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });
      
      const pageWidth = 210;
      const pageHeight = 297;
      const margin = 10;
      const contentWidth = pageWidth - (2 * margin);
      let currentY = margin;
      let isFirstPage = true;
      
      // Find all date sections (each day container)
      const dateContainers = modalContentRef.current.querySelectorAll('[class*="border-2 border-matter-neutral-300 rounded-xl"]');
      
      if (dateContainers.length === 0) {
        throw new Error('No content found to export');
      }
      
      // Process each date section
      for (let i = 0; i < dateContainers.length; i++) {
        const container = dateContainers[i];
        
        // Create a temporary container for this section
        const tempContainer = document.createElement('div');
        tempContainer.style.position = 'fixed';
        tempContainer.style.left = '-99999px';
        tempContainer.style.width = '1000px';
        tempContainer.style.backgroundColor = '#ffffff';
        tempContainer.style.padding = '20px';
        
        const clone = container.cloneNode(true);
        
        // Remove height constraints
        const allElements = clone.querySelectorAll('*');
        allElements.forEach(el => {
          el.style.maxHeight = 'none';
          el.style.height = 'auto';
          el.style.overflow = 'visible';
        });
        
        tempContainer.appendChild(clone);
        document.body.appendChild(tempContainer);
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Capture this section
        const canvas = await html2canvas(clone, {
          scale: 2,
          backgroundColor: '#ffffff',
          logging: false,
          useCORS: true,
          allowTaint: true
        });
        
        document.body.removeChild(tempContainer);
        
        const imgData = canvas.toDataURL('image/jpeg', 0.95);
        const imgWidth = contentWidth;
        const imgHeight = (canvas.height * contentWidth) / canvas.width;
        
        // Check if we need a new page
        if (!isFirstPage && (currentY + imgHeight > pageHeight - margin)) {
          pdf.addPage();
          currentY = margin;
        }
        
        // Add the image
        pdf.addImage(imgData, 'JPEG', margin, currentY, imgWidth, imgHeight);
        
        currentY += imgHeight + 5; // Add spacing between sections
        
        // If this section would make the next one overflow, start a new page
        if (currentY > pageHeight - 50) { // Leave room for next section
          pdf.addPage();
          currentY = margin;
        }
        
        isFirstPage = false;
      }
      
      // Download PDF
      const customerName = `${selectedCustomerDetail.firstName || ''} ${selectedCustomerDetail.lastName || ''}`.trim() || 'Customer';
      const fileName = `${customerName.replace(/[^a-zA-Z0-9]/g, '_')}_Selections_${new Date().toISOString().split('T')[0]}.pdf`;
      
      pdf.save(fileName);
      
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    } finally {
      setIsDownloadingPDF(false);
    }
  };

  const handleDownloadKitchenPaperPdf = async () => {
    if (!selectedCustomerDetail) return;

    try {
      setIsDownloadingKitchenPaper(true);
      const selectedDates = [...new Set((selectedCustomerDetail.selectedMeals || []).map((meal) => getDateKey(meal.date || meal.menuItemId?.itemDate)).filter(Boolean))];
      const snapshot = await loadKitchenSnapshot(api, selectionMenuId, selectedDates);
      const entry = snapshot.entries.find((row) => String(row.email || '').toLowerCase() === String(selectedCustomerDetail.email || '').toLowerCase());
      if (!entry) throw new Error('No confirmed delivery meals are available for this customer.');
      assertKitchenExportReady([entry]);
      const selectedMeals = entry.selectedMeals;
      const totalSelectedMeals = selectedMeals.length;
      const profileMeals = entry.mealsPerDay || totalSelectedMeals;
      const totalC = selectedMeals.reduce((sum, meal) => sum + Number(meal.macros?.C || 0), 0);
      const totalP = selectedMeals.reduce((sum, meal) => sum + Number(meal.macros?.P || 0), 0);
      const totalF = selectedMeals.reduce((sum, meal) => sum + Number(meal.macros?.F || 0), 0);
      const totalCalories = entry.totalCalories;
      const exclusion = entry.dietaryRestrictions?.join(', ') || 'None';
      const submittedAt = selectedCustomerDetail.lastMenuSelectionDate
        ? new Date(selectedCustomerDetail.lastMenuSelectionDate).toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
          })
        : 'N/A';

      const mealsByDate = selectedMeals.reduce((acc, meal) => {
        const key = getDateKey(meal.date || meal.menuItemId?.itemDate || '');
        if (!acc[key]) acc[key] = [];
        acc[key].push(meal);
        return acc;
      }, {});
      const sortedDateKeys = Object.keys(mealsByDate).sort();

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = 210;
      const pageHeight = 297;
      const margin = 15;
      const maxWidth = pageWidth - margin * 2;
      let currentY = margin;

      const addTextLines = (text, x, y, lineHeight = 6) => {
        const lines = pdf.splitTextToSize(text, maxWidth - x + margin);
        pdf.text(lines, x, y);
        return lines.length * lineHeight;
      };

      const addPageIfNeeded = (heightNeeded) => {
        if (currentY + heightNeeded > pageHeight - margin) {
          pdf.addPage();
          currentY = margin;
        }
      };

      const customerName = entry.customerName || 'Unnamed Customer';
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Kitchen Paper', margin, currentY);
      currentY += 10;
      pdf.setFontSize(12);
      pdf.setFont('helvetica', 'normal');
      currentY += addTextLines(`Customer: ${customerName}`, margin, currentY);
      currentY += addTextLines(`Email: ${selectedCustomerDetail.email || 'N/A'}`, margin, currentY);
      if (selectedCustomerDetail.customerId) {
        currentY += addTextLines(`Customer ID: ${selectedCustomerDetail.customerId}`, margin, currentY);
      }
      currentY += addTextLines(`Submitted: ${submittedAt}`, margin, currentY);
      currentY += addTextLines(`Meal exclusion: ${exclusion}`, margin, currentY);
      currentY += addTextLines(`Total meals selected: ${totalSelectedMeals}`, margin, currentY);
      currentY += addTextLines(`Meals in profile: ${profileMeals}`, margin, currentY);

      currentY += 4;
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Macro Summary', margin, currentY);
      currentY += 8;
      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');
      currentY += addTextLines(`Total Macros: C ${totalC}g, P ${totalP}g, F ${totalF}g`, margin, currentY);
      currentY += addTextLines(`Total Calories: ${totalCalories} kcal`, margin, currentY);
      currentY += 4;

      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Meal Selection', margin, currentY);
      currentY += 8;
      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');

      if (sortedDateKeys.length === 0) {
        currentY += addTextLines('No meals selected.', margin, currentY);
      } else {
        sortedDateKeys.forEach((dateKey) => {
          const dateLabel = dateKey ? new Date(`${dateKey}T00:00:00`).toLocaleDateString('en-US', {
            weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
          }) : 'Unknown date';
          addPageIfNeeded(10);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(12);
          pdf.text(dateLabel, margin, currentY);
          currentY += 7;
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(11);

          mealsByDate[dateKey].forEach((meal) => {
            const name = meal.mealName || meal.menuItemId?.mealName || 'Meal';
            const type = meal.mealType || meal.menuItemId?.mealType || 'Meal';
            const quantity = Number(meal.quantity) || 1;
            const mealLine = `• ${name} (${type})${quantity > 1 ? ` x${quantity}` : ''}`;
            const height = addTextLines(mealLine, margin + 2, currentY);
            currentY += height;
            currentY += addTextLines(`  P: ${meal.proteinWeight}g | C: ${meal.carbWeight}g | V: ${meal.vegWeight}g`, margin + 4, currentY);
            if (meal.carbVegAction) {
              currentY += addTextLines(`  - Carb/Veg action: ${meal.carbVegAction}`, margin + 4, currentY);
            }
            if (meal.conflict || meal.carbVegConflict?.length) {
              const conflictText = meal.conflict ? 'Conflict present' : `Conflicts: ${meal.carbVegConflict.join(', ')}`;
              currentY += addTextLines(`  - ${conflictText}`, margin + 4, currentY);
            }
            if (meal.proteinChoice || meal.carbChoice || meal.vegChoice || meal.sauceChoice) {
              const choices = [
                meal.proteinChoice ? `Protein: ${meal.proteinChoice}` : null,
                meal.carbChoice ? `Carb: ${meal.carbChoice}` : null,
                meal.vegChoice ? `Veg: ${meal.vegChoice}` : null,
                meal.sauceChoice ? `Sauce: ${meal.sauceChoice}` : null
              ].filter(Boolean).join(' | ');
              if (choices) {
                currentY += addTextLines(`  - ${choices}`, margin + 4, currentY);
              }
            }
            if (meal.description) {
              currentY += addTextLines(`  - ${meal.description}`, margin + 4, currentY);
            }
            currentY += 2;
            addPageIfNeeded(20);
          });
        });
      }

      const fileName = `${customerName.replace(/[^a-zA-Z0-9]/g, '_')}_Kitchen_Paper_${new Date().toISOString().split('T')[0]}.pdf`;
      pdf.save(fileName);
    } catch (error) {
      console.error('Error generating kitchen paper PDF:', error);
      alert(error.response?.data?.message || error.message || 'Failed to generate kitchen paper PDF. Please try again.');
    } finally {
      setIsDownloadingKitchenPaper(false);
    }
  };

  const handleDownloadSelections = (menu) => {
    if (!Array.isArray(menuSelections) || menuSelections.length === 0) return;

    const menuTitle = menu?.title || 'menu-selections';

    const resolveMealTypeOrder = (mealType) => {
      const normalized = String(mealType || '').toLowerCase();
      if (normalized === 'main') return 0;
      if (normalized === 'snack') return 1;
      if (normalized === 'breakfast') return 2;
      return 1;
    };

    const menuDateList = menu?.startDate && menu?.endDate
      ? getDateRange(menu.startDate, menu.endDate).map((date) => getDateKey(date)).filter(Boolean)
      : [];

    const uiDateList = Array.isArray(selectionDates) && selectionDates.length
      ? selectionDates.map((date) => getDateKey(date)).filter(Boolean)
      : [];

    const mealDateList = Array.from(
      new Set(
        menuSelections
          .flatMap((customer) => customer.selectedMeals || [])
          .map((meal) => getDateKey(meal.date || meal.menuItemId?.itemDate))
          .filter(Boolean)
      )
    ).sort();

    const dateList = menuDateList.length > 0
      ? menuDateList
      : uiDateList.length > 0
        ? uiDateList
        : mealDateList;

    const wb = XLSX.utils.book_new();

    if (dateList.length === 0) {
      const rows = [
        ['NAME', 'CUS ID', 'STATUS', 'AUTO-ASSIGNED'],
        ...menuSelections.map((customer) => [
          `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unnamed Customer',
          customer.customerId || '',
          'No meal selection',
          ''
        ])
      ];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, 'Selections');

      const safeTitle = String(menuTitle || 'menu-selections').replace(/[^a-z0-9-_]+/gi, '_');
      XLSX.writeFile(wb, `${safeTitle}-selections.xlsx`);
      return;
    }

    // Pre-compute which dates have at least one customer with selections.
    // If any customer selected for a date, the day was open for selection.
    const datesWithAnySelections = new Set(
      menuSelections
        .flatMap((c) => (c.selectedMeals || []).map((m) => getDateKey(m.date || m.menuItemId?.itemDate)))
        .filter(Boolean)
    );

    dateList.forEach((dateKey, index) => {
      const selectionDeadlines = menu?.selectionDeadlines || [];
      const dayIsLocked = isDateKeyLocked(dateKey, selectionDeadlines);
      // First pass: collect all unique meal names and customer data
      const uniqueMealsSet = new Set();
      const customerData = [];

      menuSelections.forEach((customer) => {
        const customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unnamed Customer';
        const selections = Array.isArray(customer.selectedMeals) ? customer.selectedMeals : [];
        const mealsForDate = selections.filter((meal) => {
          const mealDateKey = getDateKey(meal.date || meal.menuItemId?.itemDate);
          return mealDateKey === dateKey;
        });

        // Consolidate duplicate selections (for backward compatibility)
        const consolidatedMap = new Map();
        mealsForDate.forEach((meal) => {
          // Use same fallback chain as the UI: _id → raw menuItemId → mealName
          // This ensures meals still display correctly even if menuItemId was
          // nulled out (e.g. because the menu was edited and old MenuItems deleted).
          const itemId = String(meal.menuItemId?._id || meal.menuItemId || meal.mealName || '');
          if (consolidatedMap.has(itemId)) {
            const existing = consolidatedMap.get(itemId);
            existing.quantity += (meal.quantity || 1);
          } else {
            consolidatedMap.set(itemId, {
              ...meal,
              quantity: meal.quantity || 1
            });
          }
        });

        const consolidatedMeals = Array.from(consolidatedMap.values());
        consolidatedMeals.forEach((meal) => {
          const mealName = meal.mealName || meal.menuItemId?.mealName || '';
          if (mealName) {
            uniqueMealsSet.add(mealName);
          }
        });

        customerData.push({
          name: customerName,
          id: customer.customerId || '',
          email: customer.email || '',
          lastMenuSelectionDate: customer.lastMenuSelectionDate || null,
          skippedDays: customer.skippedDays || [],
          meals: consolidatedMeals
        });
      });

      // Sort unique meals alphabetically
      const uniqueMeals = Array.from(uniqueMealsSet).sort();

      // Add status column to show skipped days/no selection
      const headerRow = ['NAME', 'CUS ID', 'STATUS', 'AUTO-ASSIGNED', ...uniqueMeals];

      // Create data rows - one row per customer
      // Also track which cells need yellow highlighting (exclusion conflicts)
      const rows = [headerRow];
      const conflictCells = []; // { r, c } zero-indexed

      customerData.forEach((customer, rowIdx) => {
        const hasMealsForDay = Array.isArray(customer.meals) && customer.meals.length > 0;
        // Submitted before deadline → they chose to leave it empty → "No meal selection"
        // Submitted after deadline (or never submitted) → "Closed Day"
        const excelDeadlineForDay = getDeadlineDate(dateKey, selectionDeadlines);
        const excelSubmittedAt = customer.lastMenuSelectionDate ? new Date(customer.lastMenuSelectionDate) : null;
        const excelSubmittedBeforeDeadline = excelSubmittedAt && excelDeadlineForDay && excelSubmittedAt <= excelDeadlineForDay;
        const dayClosed = dayIsLocked && !excelSubmittedBeforeDeadline;
        // A day the customer explicitly skipped takes precedence over the
        // generic "No meal selection" — and carries the Matter pause result.
        const skipStatus = formatSkipStatus(getSkipForDate(customer, dateKey));
        const autoAssignedCount = customer.meals.filter((m) => m.isAutoAssigned).length;
        const autoAssignedLabel = !hasMealsForDay
          ? ''
          : autoAssignedCount === customer.meals.length
            ? 'Auto-Assigned'
            : autoAssignedCount > 0
              ? 'Partially Auto-Assigned'
              : '';
        const row = [
          customer.name,
          customer.id,
          skipStatus || (hasMealsForDay ? '' : dayClosed ? 'Closed Day' : 'No meal selection'),
          autoAssignedLabel
        ];

        // For each unique meal, include quantity if selected multiple times
        uniqueMeals.forEach((mealName, mealIdx) => {
          const mealsWithName = customer.meals.filter(
            (m) => (m.mealName || m.menuItemId?.mealName) === mealName
          );

          if (mealsWithName.length > 0) {
            const totalQty = mealsWithName.reduce((sum, meal) => sum + (meal.quantity || 1), 0);
            const isReplace = mealsWithName.some(m => m.carbVegAction === 'replace');
            const isKept    = mealsWithName.some(m => m.carbVegAction === 'kept');
            const hasCarb   = mealsWithName.some(m => m.carbConflict?.length > 0);
            const hasVeg    = mealsWithName.some(m => m.vegConflict?.length > 0);
            let actionLabel = '';
            if (isReplace || isKept) {
              const verb = isReplace ? 'Replace' : 'Keep';
              const what = hasCarb && hasVeg ? 'Carb+Veg' : hasCarb ? 'Carb' : hasVeg ? 'Veg' : 'Carb/Veg';
              actionLabel = ` [${verb} ${what}]`;
            }
            const conflictItems = mealsWithName.find(m => m.carbVegConflict?.length > 0)?.carbVegConflict;
            const conflictSuffix = conflictItems?.length ? ` (${conflictItems.join(', ')})` : '';
            const baseLabel = totalQty > 1 ? `${mealName} x${totalQty}` : mealName;
            row.push(`${baseLabel}${actionLabel}${conflictSuffix}`);

            // Flag for yellow highlight: meal name contains one of the customer's exclusions
            const hasConflict = mealsWithName.some((m) => m.conflict);
            if (hasConflict) {
              // rowIdx + 1 because row 0 is the header; mealIdx + 4 for NAME/CUS ID/STATUS/AUTO-ASSIGNED cols
              conflictCells.push({ r: rowIdx + 1, c: mealIdx + 4 });
            }
          } else {
            row.push('');
          }
        });

        rows.push(row);
      });

      const ws = XLSX.utils.aoa_to_sheet(rows);

      // Apply yellow fill to cells where exclusion conflicts exist
      conflictCells.forEach(({ r, c }) => {
        const cellAddr = XLSX.utils.encode_cell({ r, c });
        if (!ws[cellAddr]) ws[cellAddr] = { t: 's', v: '' };
        ws[cellAddr].s = {
          fill: { fgColor: { rgb: 'FFFF00' } },
          font: { bold: true }
        };
      });
      const sheetName = dateKey || `Day ${index + 1}`;
      XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31));
    });

    const safeTitle = String(menuTitle || 'menu-selections').replace(/[^a-z0-9-_]+/gi, '_');
    XLSX.writeFile(wb, `${safeTitle}-selections.xlsx`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader className="animate-spin text-matter-sky" size={32} />
      </div>
    );
  }

  return (
    <div className="customer-mgmt menu-mgmt min-h-screen p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between gap-8 flex-wrap mb-8 pb-6 border-b border-matter-navy/15">
          <div>
            <h1 className="font-heading-menu text-3xl font-bold text-matter-navy mb-2">Weekly menus</h1>
            <p className="text-matter-neutral-600 text-base max-w-[44ch]">Build a week of meals, share one link, and watch your subscribers pick.</p>
          </div>
          <div className="flex gap-8">
            <div>
              <div className="font-heading-menu text-[34px] leading-none font-bold text-matter-navy tabular-nums">{menus.length}</div>
              <h6 className="text-xs text-matter-neutral-500 uppercase tracking-wide mt-2">Menus</h6>
            </div>
            <div>
              <div className="font-heading-menu text-[34px] leading-none font-bold text-matter-accent-700 tabular-nums">
                {menus.reduce((s, m) => s + (m.selectionCount || 0), 0)}
              </div>
              <h6 className="text-xs text-matter-neutral-500 uppercase tracking-wide mt-2">Selections in</h6>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
          <div className="flex gap-2 flex-wrap">
            {MENU_STATUS_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setStatusFilter(tab)}
                className={`px-3.5 py-1.5 rounded-full text-sm font-semibold border transition-colors ${
                  statusFilter === tab
                    ? 'bg-matter-accent-700 border-matter-accent-700 text-white'
                    : 'bg-transparent border-matter-neutral-300 text-matter-navy hover:bg-matter-neutral-100'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => {
                setShowCreateForm(true);
                setEditingMenuId(null);
                setEditingSlot(null);
                setUploadError(null);
                setFormData({
                  title: '',
                  description: '',
                  startDate: '',
                  endDate: '',
                  mealPlans: ['Standard'],
                  enableCompletionMessage: false,
                  completionMessage: 'Your meal selections have been saved successfully.',
                  selectionDeadlines: []
                });
                setWeeklyItems([]);
              }}
              className="flex items-center gap-2 bg-matter-navy hover:bg-matter-blueblack text-white font-semibold px-4 py-2 rounded-lg transition"
            >
              <Plus size={18} />
              New menu
            </button>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-matter-red/10 border border-matter-red/30 rounded-lg p-4 mb-6 flex gap-3">
            <AlertCircle className="text-matter-red flex-shrink-0" size={20} />
            <p className="text-matter-red">{error}</p>
          </div>
        )}

        {/* Create/Edit Form */}
        {showCreateForm && (
          <div className="mb-8 pb-28">
            <button
              type="button"
              onClick={closeCreateForm}
              className="text-matter-accent-700 hover:text-matter-accent-800 text-sm font-semibold mb-3"
            >
              ← Back to menus
            </button>
            <h1 className="font-heading-menu text-3xl font-bold text-matter-navy mb-2">
              {editingMenuId ? (toSentenceCase(formData.title) || 'Edit weekly menu') : 'New weekly menu'}
            </h1>
            <p className="text-matter-neutral-700 text-base max-w-[52ch] mb-6">
              Seven days, one link. Add the meals for each day, then publish when it's ready.
            </p>

            <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
              <div className="bg-white rounded-2xl border border-matter-neutral-300 p-6">
                <h6 className="text-xs font-semibold text-matter-neutral-600 uppercase tracking-wide mb-4">Menu details</h6>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <input
                    type="text"
                    placeholder="Menu Title"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    required
                    className="px-4 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky"
                  />
                  <input
                    type="text"
                    placeholder="Description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="px-4 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky"
                  />
                  <input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                    required
                    className="px-4 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky"
                  />
                  <input
                    type="date"
                    value={formData.endDate}
                    onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                    required
                    className="px-4 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky"
                  />
                </div>
              </div>

              <div className="border border-dashed border-matter-neutral-300 rounded-lg p-4 bg-matter-neutral-100">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-semibold text-matter-navy">Upload Menu (Excel)</p>
                    <p className="text-xs text-matter-neutral-600">
                      Columns: CATEGORY, INTOLERANCES, DAY (1/2/3), GARNISH, MEAL NAME, CARB, VEG, SAUCE.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleDownloadMenuTemplate}
                      className="px-3 py-2 text-sm bg-white border border-matter-neutral-300 rounded-lg hover:bg-matter-neutral-200"
                    >
                      Download Template
                    </button>
                    <label className="px-3 py-2 text-sm bg-matter-navy text-white rounded-lg hover:bg-matter-blueblack cursor-pointer flex items-center gap-2">
                      <Upload size={16} />
                      {isUploadingMenu ? 'Uploading...' : 'Upload Excel'}
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={handleMenuUpload}
                        disabled={isUploadingMenu}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>
                {uploadError && (
                  <p className="text-sm text-red-600 mt-2">{uploadError}</p>
                )}
              </div>

              {/* Completion Message Section */}
              <div className="bg-matter-accent-100 border border-matter-accent-300 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="font-semibold text-matter-navy">Completion Message for Customers</label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.enableCompletionMessage}
                      onChange={(e) => setFormData({ ...formData, enableCompletionMessage: e.target.checked })}
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-sm text-matter-neutral-800">Enable custom message</span>
                  </label>
                </div>
                {formData.enableCompletionMessage && (
                  <textarea
                    placeholder="Enter a message to show customers after they complete their selections..."
                    value={formData.completionMessage}
                    onChange={(e) => setFormData({ ...formData, completionMessage: e.target.value })}
                    className="w-full px-4 py-2 border border-matter-accent-300 rounded-lg focus:ring-2 focus:ring-matter-sky resize-y"
                    rows={3}
                  />
                )}
              </div>

              {/* Selection Deadlines — fixed company policy, not editable per
                  menu. The server applies FIXED_SELECTION_DEADLINES to every
                  menu on create and update regardless of what's sent here;
                  this panel is read-only so it can't look configurable. */}
              <div className="bg-matter-neutral-200 border border-matter-neutral-300 rounded-lg p-4 space-y-3">
                <div>
                  <label className="font-semibold text-matter-navy">Selection Deadlines</label>
                  <p className="text-xs text-matter-neutral-600 mt-0.5">
                    Fixed for every menu — after the deadline, customers can no longer edit meals for that day.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {FIXED_SELECTION_DEADLINES.map((rule) => (
                    <div key={rule.deliveryDay} className="flex items-center justify-between bg-white border border-matter-neutral-300 rounded-lg px-3 py-2">
                      <span className="text-sm font-medium text-matter-navy">{rule.deliveryDay}</span>
                      <span className="text-xs text-matter-neutral-600">
                        locks {rule.daysBefore} day{rule.daysBefore !== 1 ? 's' : ''} before at {rule.deadlineTime}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {weeklyItems.length > 0 && (() => {
                const editingItem = editingSlot ? weeklyItems[editingSlot.dayIndex]?.items[editingSlot.itemIndex] : null;
                const updateEditingField = (field, value) => {
                  if (!editingSlot) return;
                  handleWeeklyItemChange(editingSlot.dayIndex, editingSlot.itemIndex, field, value);
                };
                const isSingleRecipeMeal = ['breakfast', 'snack'].includes(editingItem?.mealType);

                // Each component keeps two separate fields: the search field
                // itself holds the recipe's own name (what staff searched for,
                // and what the customer sees on their selection page), while a
                // second, dedicated ingredients field holds that recipe's
                // ingredients as a tagged list — each ingredient defaults to
                // visible:true (shown to the customer) and can be toggled to
                // backend-only in the IngredientTagEditor.
                const RECIPE_FIELD_BY_COMPONENT = { portion: 'proteinSource', carb: 'carbs', veg: 'veg', sauce: 'sauce' };
                const INGREDIENTS_FIELD_BY_COMPONENT = { portion: 'portionIngredients', carb: 'carbIngredients', veg: 'vegIngredients', sauce: 'sauceIngredients' };
                const TAGGED_COMPONENTS = ['portion', 'carb', 'veg', 'sauce'];
                const ingredientNames = (list) => (list || []).map((ing) => ing.name).filter(Boolean).join(', ');
                const ingredientTags = (list) => (list || []).map((ing) => ({ name: ing.name, visible: true })).filter((t) => t.name);
                // Same chicken/beef/fish keyword sniff the kitchen list's own
                // fallback uses — only ever suggests, never overwrites a
                // portionType the meal already has set.
                const guessPortionType = (text) => {
                  const t = String(text || '').toLowerCase();
                  if (t.includes('chicken')) return 'chicken';
                  if (t.includes('beef')) return 'beef';
                  if (t.includes('fish') || t.includes('shrimp') || t.includes('salmon') || t.includes('seafood')) return 'fish';
                  return '';
                };
                const applyRecipeSelection = (component, recipe) => {
                  if (!editingSlot || !recipe) return;
                  const nextItem = component === 'main'
                    ? { ...editingItem, mealName: recipe.name, ingredients: ingredientNames(recipe.ingredients) }
                    : {
                        ...editingItem,
                        [RECIPE_FIELD_BY_COMPONENT[component]]: recipe.name,
                        [INGREDIENTS_FIELD_BY_COMPONENT[component]]: TAGGED_COMPONENTS.includes(component)
                          ? ingredientTags(recipe.ingredients)
                          : ingredientNames(recipe.ingredients),
                        ...(component === 'portion' && !editingItem.portionType
                          ? { portionType: guessPortionType(recipe.name) }
                          : {})
                      };
                  setWeeklyItems((prev) => {
                    const updated = [...prev];
                    updated[editingSlot.dayIndex] = { ...updated[editingSlot.dayIndex] };
                    updated[editingSlot.dayIndex].items = [...updated[editingSlot.dayIndex].items];
                    updated[editingSlot.dayIndex].items[editingSlot.itemIndex] = nextItem;
                    return updated;
                  });
                };
                const editingAllergens = (editingItem?.allergens || '').split(',').map((s) => s.trim()).filter(Boolean);
                const toggleAllergen = (label) => {
                  const next = editingAllergens.includes(label)
                    ? editingAllergens.filter((a) => a !== label)
                    : [...editingAllergens, label];
                  updateEditingField('allergens', next.join(', '));
                };
                const dayLabel = (dateKey) => {
                  const [y, m, d] = String(dateKey).split('-').map(Number);
                  if (!y || !m || !d) return { weekday: '', date: dateKey };
                  const dt = new Date(y, m - 1, d);
                  return {
                    weekday: dt.toLocaleDateString('en-US', { weekday: 'short' }),
                    date: `${d} ${dt.toLocaleDateString('en-US', { month: 'short' })}`
                  };
                };

                return (
                  <div className="space-y-3">
                    <div className="flex items-baseline justify-between gap-4">
                      <h4 className="font-heading-menu text-lg font-bold text-matter-navy">The week</h4>
                      <span className="text-xs text-matter-neutral-600">
                        {weeklyItems.reduce((s, d) => s + d.items.length, 0)} meals across {weeklyItems.length} day{weeklyItems.length !== 1 ? 's' : ''}
                      </span>
                    </div>

                    <div className="overflow-x-auto pb-2">
                      <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${weeklyItems.length}, minmax(160px, 1fr))`, minWidth: `${weeklyItems.length * 170}px` }}>
                        {weeklyItems.map((day, dayIndex) => {
                          const { weekday, date } = dayLabel(day.date);
                          return (
                            <div key={day.date} className={`relative flex flex-col gap-2 rounded-2xl p-2.5 ${day.items.length ? 'bg-matter-neutral-100' : 'bg-transparent'}`}>
                              <div className="px-1 pb-1 flex items-start justify-between gap-1">
                                <div>
                                  <div className="font-heading-menu text-sm text-matter-navy">{weekday}</div>
                                  <div className="text-[11px] text-matter-neutral-600 mt-0.5">{date}</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setCopyDayMenuFor(copyDayMenuFor === dayIndex ? null : dayIndex)}
                                  title="Duplicate another day's meals onto this day"
                                  className="text-matter-neutral-500 hover:text-matter-accent-700 mt-0.5"
                                >
                                  <span className="material-symbols-outlined text-[16px]">content_copy</span>
                                </button>
                              </div>

                              {copyDayMenuFor === dayIndex && (
                                <div className="absolute top-9 right-2 z-10 w-40 bg-white border border-matter-neutral-300 rounded-lg shadow-lg py-1">
                                  <div className="px-3 py-1.5 text-[10.5px] font-semibold text-matter-neutral-500 uppercase tracking-wide">Copy from…</div>
                                  {weeklyItems.map((otherDay, otherIndex) => {
                                    if (otherIndex === dayIndex) return null;
                                    const otherLabel = dayLabel(otherDay.date);
                                    return (
                                      <button
                                        key={otherDay.date}
                                        type="button"
                                        disabled={otherDay.items.length === 0}
                                        onClick={() => handleDuplicateDay(otherIndex, dayIndex)}
                                        className="w-full text-left px-3 py-1.5 text-xs text-matter-navy hover:bg-matter-neutral-100 disabled:text-matter-neutral-400 disabled:hover:bg-transparent disabled:cursor-not-allowed flex items-center justify-between gap-2"
                                      >
                                        <span>{otherLabel.weekday} {otherLabel.date}</span>
                                        <span className="text-[10px] text-matter-neutral-500">{otherDay.items.length || '—'}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}

                              {day.items.map((item, itemIndex) => {
                                const isOpen = editingSlot?.dayIndex === dayIndex && editingSlot?.itemIndex === itemIndex;
                                const itemAllergens = (item.allergens || '').split(',').map((s) => s.trim()).filter(Boolean);
                                return (
                                  <div
                                    key={itemIndex}
                                    onClick={() => setEditingSlot({ dayIndex, itemIndex })}
                                    className={`cursor-pointer bg-white rounded-lg p-2.5 border-[1.5px] transition-colors ${isOpen ? 'border-matter-accent' : 'border-matter-neutral-300 hover:border-matter-accent-400'}`}
                                  >
                                    <div className="text-[9.5px] uppercase tracking-wide text-matter-accent-700 mb-1">{mealTypeLabel(item.mealType)}</div>
                                    <div className="text-xs font-semibold text-matter-navy leading-snug">{item.mealName || 'Untitled meal'}</div>
                                    {(item.carbs || item.veg) && (
                                      <div className="text-[10.5px] text-matter-neutral-600 mt-1">
                                        {[item.carbs, item.veg].filter(Boolean).join(' · ')}
                                      </div>
                                    )}
                                    {(itemAllergens.length > 0 || item.intolerances) && (
                                      <div className="flex flex-wrap gap-1 mt-1.5">
                                        {itemAllergens.map((a) => (
                                          <span key={a} className="text-[9.5px] px-1.5 py-0.5 rounded bg-matter-accent-100 text-matter-accent-800">{a}</span>
                                        ))}
                                        {item.intolerances && (
                                          <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-matter-accent2-100 text-matter-accent2-800">Exclusions</span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}

                              <button
                                type="button"
                                onClick={() => handleAddItemForDay(dayIndex)}
                                className="text-xs border border-dashed border-matter-neutral-400 text-matter-neutral-700 rounded-lg py-2 hover:bg-matter-neutral-200 transition-colors"
                              >
                                + Meal
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {editingItem && (
                      <div className="fixed inset-0 z-50 overflow-y-auto bg-white">
                        <div className="max-w-3xl mx-auto p-6 sm:p-10">
                          <div className="flex items-center justify-between gap-3 mb-1.5">
                            <h6 className="text-xs font-semibold text-matter-neutral-600 uppercase tracking-wide">Editing meal</h6>
                            <button type="button" onClick={() => setEditingSlot(null)} className="text-matter-accent-700 hover:text-matter-accent-800 text-sm font-semibold">
                              Close
                            </button>
                          </div>
                          <h4 className="font-heading-menu text-xl font-bold text-matter-navy mb-5">{editingItem.mealName || 'New meal'}</h4>

                          <div className="flex flex-col gap-4">
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">Meal type</label>
                                <select
                                  value={editingItem.mealType}
                                  onChange={(e) => updateEditingField('mealType', e.target.value)}
                                  className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm"
                                >
                                  <option value="breakfast">Breakfast</option>
                                  <option value="main">Main Meal</option>
                                  <option value="snack">Snack</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">Price (AED)</label>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={editingItem.price ?? 0}
                                  onChange={(e) => updateEditingField('price', Number(e.target.value))}
                                  className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm"
                                />
                              </div>
                            </div>

                            {!isSingleRecipeMeal && (
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">Portion type</label>
                                  <select
                                    value={editingItem.portionType || ''}
                                    onChange={(e) => updateEditingField('portionType', e.target.value)}
                                    className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm"
                                  >
                                    <option value="">— none —</option>
                                    <option value="chicken">Chicken</option>
                                    <option value="beef">Beef</option>
                                    <option value="fish">Fish</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">Rotation category</label>
                                  <select
                                    value={editingItem.rotationCategory || ''}
                                    onChange={(e) => updateEditingField('rotationCategory', e.target.value)}
                                    className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm"
                                  >
                                    <option value="">— none —</option>
                                    <option value="main">Main (today's primary options)</option>
                                    <option value="sub">Sub (fallback only)</option>
                                  </select>
                                  <label className="mt-2 flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={!!editingItem.usedForCorePlan}
                                      onChange={(e) => updateEditingField('usedForCorePlan', e.target.checked)}
                                      className="w-4 h-4 rounded"
                                    />
                                    <span className="text-xs text-matter-neutral-700">Also tag for Core Plan</span>
                                  </label>
                                  <p className="text-[10.5px] text-matter-neutral-500 mt-0.5">
                                    Independent of Main/Sub above — this meal is also used in the Matter Core plan's own rotation.
                                  </p>
                                </div>
                              </div>
                            )}

                            <div>
                              <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">
                                Meal name {isSingleRecipeMeal && <span className="font-normal text-matter-neutral-500">— searches Supy recipes</span>}
                              </label>
                              {isSingleRecipeMeal ? (
                                <SupyRecipeSearch
                                  value={editingItem.mealName}
                                  onChangeText={(text) => updateEditingField('mealName', text)}
                                  onSelect={(recipe) => applyRecipeSelection('main', recipe)}
                                  placeholder="Search Supy — e.g. Oatmeal berry bowl"
                                />
                              ) : (
                                <input
                                  type="text"
                                  value={editingItem.mealName}
                                  onChange={(e) => updateEditingField('mealName', e.target.value)}
                                  className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm"
                                  placeholder="Grilled lemon chicken"
                                />
                              )}
                            </div>

                            {!isSingleRecipeMeal && (
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">PORTION — searches Supy</label>
                                  <SupyRecipeSearch
                                    value={editingItem.proteinSource}
                                    onChangeText={(text) => updateEditingField('proteinSource', text)}
                                    onSelect={(recipe) => applyRecipeSelection('portion', recipe)}
                                    placeholder="e.g. Grilled chicken breast"
                                  />
                                  <label className="block text-[11px] font-semibold text-matter-neutral-500 mt-2 mb-1">Portion ingredients</label>
                                  <IngredientTagEditor
                                    value={editingItem.portionIngredients}
                                    onChange={(tags) => updateEditingField('portionIngredients', tags)}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">CARB — searches Supy</label>
                                  <SupyRecipeSearch
                                    value={editingItem.carbs}
                                    onChangeText={(text) => updateEditingField('carbs', text)}
                                    onSelect={(recipe) => applyRecipeSelection('carb', recipe)}
                                    placeholder="e.g. Basmati rice"
                                  />
                                  <label className="block text-[11px] font-semibold text-matter-neutral-500 mt-2 mb-1">Carb ingredients</label>
                                  <IngredientTagEditor
                                    value={editingItem.carbIngredients}
                                    onChange={(tags) => updateEditingField('carbIngredients', tags)}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">VEG — searches Supy</label>
                                  <SupyRecipeSearch
                                    value={editingItem.veg}
                                    onChangeText={(text) => updateEditingField('veg', text)}
                                    onSelect={(recipe) => applyRecipeSelection('veg', recipe)}
                                    placeholder="e.g. Steamed broccoli"
                                  />
                                  <label className="block text-[11px] font-semibold text-matter-neutral-500 mt-2 mb-1">Veg ingredients</label>
                                  <IngredientTagEditor
                                    value={editingItem.vegIngredients}
                                    onChange={(tags) => updateEditingField('vegIngredients', tags)}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">SAUCE — searches Supy</label>
                                  <SupyRecipeSearch
                                    value={editingItem.sauce}
                                    onChangeText={(text) => updateEditingField('sauce', text)}
                                    onSelect={(recipe) => applyRecipeSelection('sauce', recipe)}
                                    placeholder="e.g. Lemon herb sauce"
                                  />
                                  <label className="block text-[11px] font-semibold text-matter-neutral-500 mt-2 mb-1">Sauce ingredients</label>
                                  <IngredientTagEditor
                                    value={editingItem.sauceIngredients}
                                    onChange={(tags) => updateEditingField('sauceIngredients', tags)}
                                  />
                                </div>
                              </div>
                            )}

                            {!isSingleRecipeMeal && (
                              <div>
                                <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">GARNISH — typed manually, no Supy search</label>
                                <input
                                  type="text"
                                  value={editingItem.garnish || ''}
                                  onChange={(e) => updateEditingField('garnish', e.target.value)}
                                  className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm"
                                  placeholder="e.g. Parsley, lemon wedge"
                                />
                              </div>
                            )}

                            <div>
                              <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">
                                Ingredients {isSingleRecipeMeal && <span className="font-normal text-matter-neutral-500">— pulled from Supy, editable</span>}
                              </label>
                              <textarea
                                rows={3}
                                value={editingItem.ingredients}
                                onChange={(e) => updateEditingField('ingredients', e.target.value)}
                                className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm resize-y"
                                placeholder="Chicken breast, lemon, garlic, olive oil, thyme"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">Allergens (hard block)</label>
                              <div className="flex flex-wrap gap-1.5">
                                {ALLERGEN_OPTIONS.map((label) => {
                                  const on = editingAllergens.includes(label);
                                  return (
                                    <button
                                      type="button"
                                      key={label}
                                      onClick={() => toggleAllergen(label)}
                                      className={`text-xs px-3 py-1 rounded-full border transition-colors ${on ? 'bg-matter-accent-700 border-matter-accent-700 text-white' : 'bg-transparent border-matter-neutral-300 text-matter-neutral-800 hover:border-matter-accent-400'}`}
                                    >
                                      {label}
                                    </button>
                                  );
                                })}
                              </div>
                              <p className="text-[11px] text-matter-neutral-600 mt-1.5">If a customer's allergies match any of these, this meal is completely blocked for them.</p>
                            </div>

                            <div>
                              <label className="block text-xs font-semibold text-matter-neutral-700 mb-1.5">Intolerances / exclusions</label>
                              <textarea
                                rows={2}
                                value={editingItem.intolerances}
                                onChange={(e) => updateEditingField('intolerances', e.target.value)}
                                className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm resize-y"
                                placeholder="e.g. dairy, gluten free flour, tahina (comma-separated)"
                              />
                              <p className="text-[11px] text-matter-neutral-600 mt-1.5">Soft warning — the customer can acknowledge and still pick the meal.</p>
                            </div>
                          </div>

                          <div className="flex gap-2 mt-6 pt-5 border-t border-matter-navy/15">
                            <button
                              type="button"
                              onClick={() => handleDuplicateItem(editingSlot.dayIndex, editingSlot.itemIndex)}
                              className="px-3 py-2 text-sm border border-matter-neutral-300 rounded-lg text-matter-neutral-800 hover:bg-matter-neutral-100"
                            >
                              Duplicate
                            </button>
                            <div className="flex-1" />
                            <button
                              type="button"
                              onClick={() => handleRemoveItemForDay(editingSlot.dayIndex, editingSlot.itemIndex)}
                              className="px-3 py-2 text-sm text-matter-red hover:opacity-80"
                            >
                              Remove meal
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="sticky bottom-0 -mx-6 mt-8 px-6 py-4 bg-white border-t border-matter-neutral-300 flex items-center justify-between gap-4">
                <span className="text-xs text-matter-neutral-600 hidden sm:block">
                  {weeklyItems.reduce((s, d) => s + d.items.length, 0)} meal{weeklyItems.reduce((s, d) => s + d.items.length, 0) !== 1 ? 's' : ''} planned
                  {' · fixed deadlines apply'}
                </span>
                <div className="flex gap-3 ml-auto">
                  <button
                    type="button"
                    onClick={closeCreateForm}
                    className="px-5 py-2 border border-matter-neutral-300 text-matter-neutral-800 font-semibold rounded-lg hover:bg-matter-neutral-100 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSaveMenu({ publish: false })}
                    className="px-5 py-2 border border-matter-accent-700 text-matter-accent-700 font-semibold rounded-lg hover:bg-matter-accent-100 transition"
                  >
                    Save draft
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSaveMenu({ publish: true })}
                    className="px-5 py-2 bg-matter-green hover:opacity-90 text-matter-navy font-semibold rounded-lg transition"
                  >
                    Publish &amp; copy link
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {/* Menus List */}
        {(() => {
          const visibleMenus = statusFilter === 'All' ? menus : menus.filter((m) => getMenuStatus(m) === statusFilter);
          if (menus.length === 0) {
            return (
              <div className="bg-white rounded-2xl border border-dashed border-matter-neutral-400 p-16 text-center">
                <Calendar className="mx-auto text-matter-neutral-400 mb-3" size={48} />
                <p className="text-matter-neutral-600">No menus yet. Create one to get started!</p>
              </div>
            );
          }
          if (visibleMenus.length === 0) {
            return (
              <div className="bg-white rounded-2xl border border-dashed border-matter-neutral-400 p-16 text-center">
                <h3 className="font-heading-menu text-lg font-bold text-matter-navy mb-1">Nothing on this shelf</h3>
                <p className="text-matter-neutral-600 text-sm">No menus match this filter.</p>
              </div>
            );
          }
          return (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(378px, 1fr))' }}>
          {visibleMenus.map((menu) => {
            const status = getMenuStatus(menu);
            const dayStrip = getMenuDayStrip(menu);
            return (
              <div
                key={menu._id}
                className="bg-white rounded-2xl border border-matter-neutral-300 p-6"
              >
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${MENU_STATUS_STYLE[status]}`}>
                    {status}
                  </span>
                  <span className="text-xs text-matter-neutral-500 font-mono tabular-nums">{String(menu._id).slice(-6).toUpperCase()}</span>
                </div>

                <h3 className="font-heading-menu text-xl font-bold text-matter-navy mb-1">{toSentenceCase(menu.title)}</h3>
                <p className="text-matter-neutral-600 text-sm mb-1">
                  {menu.startDate ? new Date(menu.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                  {' — '}
                  {menu.endDate ? new Date(menu.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                </p>
                {menu.description && <p className="text-matter-neutral-600 text-sm mb-3 line-clamp-1">{menu.description}</p>}

                <div className="flex gap-1 mb-5">
                  {dayStrip.map((d, i) => (
                    <div
                      key={i}
                      className={`flex-1 text-center py-1.5 rounded-md ${d.count ? 'bg-matter-accent2-200 text-matter-accent2-800' : 'bg-matter-neutral-200 text-matter-neutral-500'}`}
                    >
                      <div className="text-[10px] uppercase tracking-wide opacity-75">{d.label}</div>
                      <div className="text-[13px] tabular-nums mt-0.5">{d.count}</div>
                    </div>
                  ))}
                </div>

                <div className="flex items-end gap-6 pt-4 border-t border-matter-navy/15 mb-4">
                  <div>
                    <div className="font-heading-menu text-2xl font-bold text-matter-navy tabular-nums">{menu.selectionCount || 0}</div>
                    <h6 className="text-[11px] text-matter-neutral-500 uppercase tracking-wide mt-1.5">Selections</h6>
                  </div>
                  <div>
                    <div className="font-heading-menu text-2xl font-bold text-matter-neutral-500 tabular-nums flex items-center gap-1.5">
                      <Eye size={16} />
                      {menu.viewCount || 0}
                    </div>
                    <h6 className="text-[11px] text-matter-neutral-500 uppercase tracking-wide mt-1.5">Link opens</h6>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 pt-4 border-t border-matter-navy/15">
                  <button
                    onClick={() => handleEditMenu(menu._id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-matter-neutral-100 text-matter-neutral-800 hover:bg-matter-neutral-200 transition"
                  >
                    Edit
                  </button>

                  <button
                    onClick={() => handleViewSelections(menu._id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${selectionMenuId === menu._id ? 'bg-matter-navy text-white' : 'bg-matter-neutral-100 text-matter-neutral-800 hover:bg-matter-neutral-200'}`}
                  >
                    {selectionMenuId === menu._id ? 'Hide selections' : 'View selections'}
                  </button>

                  {menu.isPublished ? (
                    <button
                      onClick={() => copyShareLink(menu._id)}
                      disabled={menu.shareLink?.isActive === false}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                        copiedLink === menu._id
                          ? 'bg-matter-accent2-300 text-matter-navy'
                          : menu.shareLink?.isActive === false
                            ? 'bg-matter-neutral-100 text-matter-neutral-400 cursor-not-allowed'
                            : 'bg-matter-neutral-100 text-matter-neutral-800 hover:bg-matter-neutral-200'
                      }`}
                    >
                      {copiedLink === menu._id ? 'Copied!' : 'Copy link'}
                    </button>
                  ) : (
                    <button
                      onClick={() => handlePublishMenu(menu._id)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-matter-navy text-white hover:bg-matter-blueblack transition"
                    >
                      Publish
                    </button>
                  )}

                  {menu.shareLink?.isActive !== false && (
                    <a
                      href={`/menu-select/${menu.shareLink?.token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-matter-neutral-100 text-matter-neutral-800 hover:bg-matter-neutral-200 transition"
                    >
                      Preview
                    </a>
                  )}

                  <div className="flex-1" />

                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setOpenActionsMenuId(openActionsMenuId === menu._id ? null : menu._id)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-matter-neutral-100 hover:bg-matter-neutral-200 text-matter-neutral-600 transition"
                      title="More actions"
                    >
                      ⋯
                    </button>
                    {openActionsMenuId === menu._id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setOpenActionsMenuId(null)} />
                        <div className="absolute right-0 top-9 z-20 w-48 bg-white rounded-xl border border-matter-neutral-300 shadow-lg py-1.5">
                          {menu.isPublished && (
                            <button
                              onClick={() => { handleToggleShareLink(menu._id, menu.shareLink?.isActive !== false); setOpenActionsMenuId(null); }}
                              className="w-full text-left px-3.5 py-2 text-sm text-matter-neutral-800 hover:bg-matter-neutral-100"
                            >
                              {menu.shareLink?.isActive === false ? 'Reopen link' : 'Stop link'}
                            </button>
                          )}
                          <button
                            onClick={() => { handleDownloadMenuPDF(menu); setOpenActionsMenuId(null); }}
                            disabled={isDownloadingMenuPDF}
                            className="w-full text-left px-3.5 py-2 text-sm text-matter-neutral-800 hover:bg-matter-neutral-100 disabled:opacity-50"
                          >
                            {isDownloadingMenuPDF ? 'Downloading…' : 'Download menu PDF'}
                          </button>
                          <button
                            onClick={() => { handleDownloadMenuExcel(menu); setOpenActionsMenuId(null); }}
                            disabled={isDownloadingMenuExcel}
                            className="w-full text-left px-3.5 py-2 text-sm text-matter-neutral-800 hover:bg-matter-neutral-100 disabled:opacity-50"
                          >
                            {isDownloadingMenuExcel ? 'Downloading…' : 'Download menu Excel'}
                          </button>
                          <div className="my-1 border-t border-matter-neutral-200" />
                          <button
                            onClick={() => { setOpenActionsMenuId(null); handleDeleteMenu(menu._id); }}
                            className="w-full text-left px-3.5 py-2 text-sm text-matter-red hover:bg-matter-red/5"
                          >
                            Delete menu
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {selectionMenuId === menu._id && (
                  <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setSelectionMenuId(null)}>
                  <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
                      <h4 className="font-heading-menu text-lg font-bold text-matter-navy">Customer Selections — {toSentenceCase(menu.title)}</h4>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleDownloadSelections(menu)}
                          disabled={selectionLoading || menuSelections.length === 0}
                          className="flex items-center gap-2 bg-matter-accent2-300 text-matter-navy hover:bg-matter-accent2-400 px-3 py-2 rounded-lg transition text-sm disabled:opacity-50"
                        >
                          <Download size={16} />
                          Download Excel
                        </button>
                        <button
                          onClick={() => setSelectionMenuId(null)}
                          className="text-matter-neutral-600 hover:text-matter-navy p-2 rounded-lg hover:bg-matter-neutral-100"
                          title="Close"
                        >
                          <X size={18} />
                        </button>
                      </div>
                    </div>

                    {selectionLoading && (
                      <div className="flex items-center gap-2 text-matter-neutral-700">
                        <Loader className="animate-spin" size={16} />
                        Loading selections...
                      </div>
                    )}

                    {selectionError && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
                        {selectionError}
                      </div>
                    )}

                    {!selectionLoading && !selectionError && menuSelections.length === 0 && (
                      <div className="text-matter-neutral-600 text-sm">No selections yet.</div>
                    )}

                    {menuSelections.length > 0 && (
                      <div className="mb-4">
                        <input
                          type="text"
                          placeholder="Search customers..."
                          value={selectionSearch}
                          onChange={(e) => setSelectionSearch(e.target.value)}
                          className="w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky focus:border-transparent"
                        />
                      </div>
                    )}

                    {!selectionLoading && !selectionError && menuSelections.length > 0 && (
                      <div className="space-y-3">
                        {menuSelections
                          .filter((cust) => {
                            const q = selectionSearch.toLowerCase();
                            if (!q) return true;
                            const name = `${cust.firstName || ''} ${cust.lastName || ''}`.toLowerCase();
                            const email = (cust.email || '').toLowerCase();
                            return name.includes(q) || email.includes(q);
                          })
                          .map((customer) => (
                          <div 
                            key={customer._id} 
                            onClick={() => setSelectedCustomerDetail(customer)}
                            className="bg-white rounded-lg p-4 border-2 border-matter-neutral-300 shadow-sm hover:shadow-md transition-shadow cursor-pointer hover:border-matter-accent-400"
                          >
                            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
                              <div className="flex items-start gap-3">
                                <div className="w-10 h-10 bg-gradient-to-br from-matter-accent-500 to-matter-accent-800 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                                  {(() => {
                                    const firstName = customer.firstName || '';
                                    const lastName = customer.lastName || '';
                                    return `${firstName.charAt(0) || ''}${lastName.charAt(0) || 'C'}`.toUpperCase();
                                  })()}
                                </div>
                                <div>
                                  <div className="font-bold text-base text-matter-navy">
                                    {`${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unnamed Customer'}
                                  </div>
                                  <div className="text-sm text-matter-neutral-700">{customer.email || 'No email'}</div>
                                  {customer.customerId && (
                                    <div className="text-xs text-matter-neutral-500">ID: {customer.customerId}</div>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {(() => {
                                  const meals = customer.selectedMeals || [];
                                  const autoCount = meals.filter((m) => m.isAutoAssigned).length;
                                  if (autoCount === 0) return null;
                                  const label = autoCount === meals.length ? 'Auto-Assigned' : 'Partially Auto-Assigned';
                                  return (
                                    <span
                                      title="Some or all of this customer's meals were filled in by kitchen auto-assign, not chosen by them"
                                      className="flex-shrink-0 rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-amber-700"
                                    >
                                      {label}
                                    </span>
                                  );
                                })()}
                                <div className="bg-matter-accent-200 text-matter-navy px-3 py-1.5 rounded-lg text-sm font-semibold">
                                  {(() => {
                                    // Calculate total meals accounting for quantity
                                    const total = (customer.selectedMeals || []).reduce((sum, meal) =>
                                      sum + (meal.quantity || 1), 0
                                    );
                                    return total;
                                  })()} meal{(() => {
                                    const total = (customer.selectedMeals || []).reduce((sum, meal) =>
                                      sum + (meal.quantity || 1), 0
                                    );
                                    return total === 1 ? '' : 's';
                                  })()}
                                </div>
                                {customer.lastMenuSelectionDate && (
                                  <div className="text-right">
                                    <div className="text-xs text-matter-neutral-600">
                                      {new Date(customer.lastMenuSelectionDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                    </div>
                                    <div className="text-xs text-matter-neutral-500">
                                      {new Date(customer.lastMenuSelectionDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                  </div>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDeleteCustomerSelection(selectionMenuId, customer); }}
                                  className="text-red-500 hover:bg-red-50 border border-red-200 rounded-lg p-1.5 transition-colors"
                                  title="Delete selection"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>

                            {Array.isArray(selectionDates) && selectionDates.length > 0 && (
                              <div className="mt-3 space-y-2">
                                {selectionDates.map((date) => {
                                  const key = getDateKey(date);
                                  const mealsForDate = (customer.selectedMeals || []).filter(m => {
                                    const mealDate = m.date || m.menuItemId?.itemDate;
                                    return getDateKey(mealDate) === key;
                                  });
                                  
                                  // Consolidate duplicate meals
                                  const consolidatedMap = new Map();
                                  mealsForDate.forEach(meal => {
                                    const itemId = String(meal.menuItemId?._id || meal.menuItemId || meal.mealName || '');
                                    if (consolidatedMap.has(itemId)) {
                                      const existing = consolidatedMap.get(itemId);
                                      existing.quantity += (meal.quantity || 1);
                                    } else {
                                      consolidatedMap.set(itemId, {
                                        ...meal,
                                        quantity: meal.quantity || 1
                                      });
                                    }
                                  });
                                  
                                  const mealsFor = Array.from(consolidatedMap.values());
                                  const currentMenuDeadlines = menus.find(m => m._id === selectionMenuId)?.selectionDeadlines || [];
                                  // If day is locked AND customer submitted AFTER the deadline → they never
                                  // had a chance to select it → "Closed Day".
                                  // If day is locked AND customer submitted BEFORE the deadline → they
                                  // deliberately left it empty → "No meal selection".
                                  const dayIsLocked = isDateKeyLocked(key, currentMenuDeadlines);
                                  const submittedAt = customer.lastMenuSelectionDate ? new Date(customer.lastMenuSelectionDate) : null;
                                  const deadlineForDay = getDeadlineDate(key, currentMenuDeadlines);
                                  const submittedBeforeDeadline = submittedAt && deadlineForDay && submittedAt <= deadlineForDay;
                                  const dayLocked = dayIsLocked && !submittedBeforeDeadline;
                                  const dayClass = mealsFor.length === 0
                                    ? (dayLocked ? 'bg-matter-neutral-100 border-matter-neutral-300' : 'bg-red-50 border-red-200')
                                    : 'bg-white';
                                  
                                  // Helper function to get meal type styling and icon
                                  const getMealStyle = (mealType) => {
                                    const type = (mealType || '').toLowerCase();
                                    if (type.includes('breakfast')) {
                                      return {
                                        bg: 'bg-matter-dust/40',
                                        border: 'border-matter-dust',
                                        text: 'text-matter-charcoal',
                                        badge: 'bg-matter-dust/60 text-matter-charcoal',
                                        icon: Coffee
                                      };
                                    } else if (type.includes('main')) {
                                      return {
                                        bg: 'bg-green-50',
                                        border: 'border-green-200',
                                        text: 'text-green-800',
                                        badge: 'bg-green-100 text-green-700',
                                        icon: Sandwich
                                      };
                                    } else if (type.includes('snack')) {
                                      return {
                                        bg: 'bg-matter-neutral-200',
                                        border: 'border-matter-neutral-300',
                                        text: 'text-matter-navy',
                                        badge: 'bg-matter-accent-200 text-matter-navy',
                                        icon: Cookie
                                      };
                                    }
                                    return {
                                      bg: 'bg-matter-neutral-100',
                                      border: 'border-matter-neutral-300',
                                      text: 'text-matter-navy',
                                      badge: 'bg-matter-neutral-200 text-matter-neutral-800',
                                      icon: Sandwich
                                    };
                                  };

                                  const cardSkip = getSkipForDate(customer, key);

                                  return (
                                    <div key={key} className={`${dayClass} rounded-lg border-2 p-3 shadow-sm`}>
                                      <div className="font-semibold text-sm text-matter-neutral-800 mb-2 flex items-center gap-2">
                                        <Calendar className="w-4 h-4 text-matter-neutral-600" />
                                        {date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                                      </div>
                                      {cardSkip && (
                                        <div className={`text-xs font-medium flex items-start gap-1 py-1 ${cardSkip.pauseStatus === 'failed' ? 'text-red-600' : 'text-matter-charcoal'}`}>
                                          <PauseCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                                          <span>{formatSkipStatus(cardSkip)}</span>
                                        </div>
                                      )}
                                      {mealsFor.length === 0 ? (
                                        dayLocked ? (
                                          <div className="text-sm text-matter-neutral-600 font-medium flex items-center gap-1 py-1">
                                            🔒 Closed Day
                                          </div>
                                        ) : (
                                          <div className="text-sm text-red-600 font-medium flex items-center gap-1 py-1">
                                            <AlertCircle className="w-4 h-4" />
                                            No meal selection
                                          </div>
                                        )
                                      ) : (
                                        <div className="space-y-2">
                                          {mealsFor.map((meal, idx) => {
                                            const mealStyle = getMealStyle(meal.mealType || meal.menuItemId?.mealType);
                                            const MealIcon = mealStyle.icon;
                                            return (
                                              <div
                                                key={idx}
                                                className={`${mealStyle.bg} ${mealStyle.border} border-l-4 rounded-lg p-2.5 ${meal.conflict ? 'ring-2 ring-yellow-400' : ''}`}
                                              >
                                                <div className="flex items-start gap-2">
                                                  <MealIcon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${mealStyle.text}`} />
                                                  <div className="flex-1 min-w-0">
                                                    <div className="font-semibold text-sm text-matter-navy break-words">
                                                      {meal.mealName || meal.menuItemId?.mealName || 'Meal'}
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                                                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${mealStyle.badge}`}>
                                                        {meal.mealType || meal.menuItemId?.mealType || 'meal'}
                                                      </span>
                                                      {meal.quantity > 1 && (
                                                        <span className="text-xs font-bold bg-matter-accent-200 text-matter-navy px-2 py-0.5 rounded-full">
                                                          Qty: {meal.quantity}
                                                        </span>
                                                      )}
                                                      {meal.carbVegAction === 'replace' && (
                                                        <span className="text-xs font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                                                          🔄 Replace carb/veg
                                                        </span>
                                                      )}
                                                      {meal.carbVegAction === 'kept' && (
                                                        <span className="text-xs font-bold bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                                                          ✓ Keep carb/veg
                                                        </span>
                                                      )}
                                                      {meal.conflict && (
                                                        <span className="text-xs font-bold bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
                                                          ⚠️ Exclusion
                                                        </span>
                                                      )}
                                                    </div>
                                                    {meal.carbVegConflict?.length > 0 && (
                                                      <div className="text-xs text-matter-neutral-600 mt-1">
                                                        Conflicting: {meal.carbVegConflict.join(', ')}
                                                      </div>
                                                    )}
                                                  </div>
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
          );
        })()}
      </div>

      {/* Customer Detail Modal */}
      {selectedCustomerDetail && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50" onClick={() => setSelectedCustomerDetail(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div ref={modalContentRef}>
              {/* Modal Header */}
              <div className="bg-gradient-to-r from-matter-navy to-matter-sky text-white p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 bg-white bg-opacity-20 rounded-full flex items-center justify-center text-white font-bold text-xl">
                      {(() => {
                        const firstName = selectedCustomerDetail.firstName || '';
                        const lastName = selectedCustomerDetail.lastName || '';
                        return `${firstName.charAt(0) || ''}${lastName.charAt(0) || 'C'}`.toUpperCase();
                      })()}
                    </div>
                    <div>
                      <h2 className="text-2xl font-bold mb-1 flex items-center gap-2 flex-wrap">
                        {`${selectedCustomerDetail.firstName || ''} ${selectedCustomerDetail.lastName || ''}`.trim() || 'Unnamed Customer'}
                        {(() => {
                          const meals = selectedCustomerDetail.selectedMeals || [];
                          const autoCount = meals.filter((m) => m.isAutoAssigned).length;
                          if (autoCount === 0) return null;
                          const label = autoCount === meals.length ? 'Auto-Assigned' : 'Partially Auto-Assigned';
                          return (
                            <span
                              title="Some or all of this customer's meals were filled in by kitchen auto-assign, not chosen by them"
                              className="flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-700"
                            >
                              {label}
                            </span>
                          );
                        })()}
                      </h2>
                      <p className="text-white/70">{selectedCustomerDetail.email || 'No email'}</p>
                      {selectedCustomerDetail.customerId && (
                        <p className="text-white/60 text-sm mt-1">ID: {selectedCustomerDetail.customerId}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleDownloadAsImage}
                      disabled={isDownloadingImage || isDownloadingPDF}
                      className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-3 py-2 transition-colors flex items-center gap-2 disabled:opacity-50"
                      title="Download as JPEG"
                    >
                      {isDownloadingImage ? (
                        <Loader className="w-5 h-5 animate-spin" />
                      ) : (
                        <ImageIcon className="w-5 h-5" />
                      )}
                      <span className="text-sm font-medium">JPEG</span>
                    </button>
                    <button
                      onClick={handleDownloadAsPDF}
                      disabled={isDownloadingImage || isDownloadingPDF || isDownloadingKitchenPaper}
                      className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-3 py-2 transition-colors flex items-center gap-2 disabled:opacity-50"
                      title="Download as PDF"
                    >
                      {isDownloadingPDF ? (
                        <Loader className="w-5 h-5 animate-spin" />
                      ) : (
                        <FileText className="w-5 h-5" />
                      )}
                      <span className="text-sm font-medium">PDF</span>
                    </button>
                    <button
                      onClick={() => {
                        const existing = selectedCustomerDetail?.macros?.presets || {};
                        setPresetMacroForm({
                          breakfast: {
                            C: existing.breakfast?.C ?? '',
                            P: existing.breakfast?.P ?? '',
                            F: existing.breakfast?.F ?? ''
                          },
                          snack: {
                            C: existing.snack?.C ?? '',
                            P: existing.snack?.P ?? '',
                            F: existing.snack?.F ?? ''
                          }
                        });
                        setShowPresetMacroModal(true);
                      }}
                      className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-3 py-2 transition-colors flex items-center gap-2"
                      title="Set breakfast & snack macro presets"
                    >
                      <Coffee className="w-5 h-5" />
                      <span className="text-sm font-medium">Presets</span>
                    </button>
                    <button
                      onClick={handleDownloadKitchenPaperPdf}
                      disabled={isDownloadingImage || isDownloadingPDF || isDownloadingKitchenPaper}
                      className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-3 py-2 transition-colors flex items-center gap-2 disabled:opacity-50"
                      title="Download kitchen paper PDF"
                    >
                      {isDownloadingKitchenPaper ? (
                        <Loader className="w-5 h-5 animate-spin" />
                      ) : (
                        <Download className="w-5 h-5" />
                      )}
                      <span className="text-sm font-medium">Kitchen Paper</span>
                    </button>
                    <button
                      onClick={() => handleDeleteCustomerSelection(selectionMenuId, selectedCustomerDetail)}
                      className="bg-red-500 hover:bg-red-600 text-white rounded-lg px-3 py-2 transition-colors flex items-center gap-2"
                      title="Delete selection"
                    >
                      <Trash2 className="w-5 h-5" />
                      <span className="text-sm font-medium">Delete</span>
                    </button>
                    <button
                      onClick={async () => {
                        setEditDraft(JSON.parse(JSON.stringify(selectedCustomerDetail.selectedMeals || [])));
                        setIsEditingSelections(true);
                        setEditOpenSlot(null);
                        setEditMenuLoading(true);
                        try {
                          const [menuRes, profileRes] = await Promise.all([
                            (!editMenuData || editMenuData._id !== selectionMenuId)
                              ? api.get(`/menus/${selectionMenuId}`)
                              : Promise.resolve(null),
                            api.get(`/menus/customers/${encodeURIComponent(selectedCustomerDetail.matterEmail || selectedCustomerDetail.email)}/subscription-profile`, { params: { menuId: selectionMenuId } })
                          ]);
                          if (menuRes?.data?.success) setEditMenuData(menuRes.data.data);
                          if (profileRes?.data?.success) {
                            const p = profileRes.data.data;
                            setSelectedCustomerDetail(prev => ({
                              ...prev,
                              mealPerDay: p.mealPerDay ?? prev.mealPerDay,
                              breakfastInclude: p.breakfastInclude ?? prev.breakfastInclude
                            }));
                          }
                        } catch (e) { console.error('Failed to load data for editing', e); }
                        finally { setEditMenuLoading(false); }
                      }}
                      className="bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg px-3 py-2 transition-colors flex items-center gap-2"
                      title="Edit selections"
                    >
                      <span className="text-sm font-medium">Edit Selections</span>
                    </button>
                    <button
                      onClick={() => setSelectedCustomerDetail(null)}
                      className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2 transition-colors"
                    >
                      <X className="w-6 h-6" />
                    </button>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-4">
                  <div className="bg-white bg-opacity-20 px-4 py-2 rounded-lg">
                    <div className="text-sm text-white/70">Total Meals</div>
                    <div className="text-2xl font-bold">
                      {(selectedCustomerDetail.selectedMeals || []).reduce((sum, meal) => sum + (meal.quantity || 1), 0)}
                    </div>
                  </div>
                  <div className="bg-white bg-opacity-20 px-4 py-2 rounded-lg">
                    <div className="text-sm text-white/70">Days with Selections</div>
                    <div className="text-2xl font-bold">
                      {(() => {
                        const uniqueDates = new Set();
                        (selectedCustomerDetail.selectedMeals || []).forEach(meal => {
                          const mealDate = meal.date || meal.menuItemId?.itemDate;
                          if (mealDate) uniqueDates.add(getDateKey(mealDate));
                        });
                        return uniqueDates.size;
                      })()}
                    </div>
                  </div>
                  {selectedCustomerDetail.lastMenuSelectionDate && (
                    <div className="bg-white bg-opacity-20 px-4 py-2 rounded-lg">
                      <div className="text-sm text-white/70">Submitted</div>
                      <div className="text-sm font-semibold mt-0.5">
                        {new Date(selectedCustomerDetail.lastMenuSelectionDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                      </div>
                      <div className="text-xs text-white/60">
                        {new Date(selectedCustomerDetail.lastMenuSelectionDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Modal Body */}
              <div className="p-6 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 240px)' }}>
                {isEditingSelections ? (
                  <div className="space-y-5" onClick={() => setEditOpenSlot(null)}>
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-bold text-matter-navy">Edit Meal Selections</h3>
                      <span className="text-xs text-matter-neutral-500">Bypasses allergen blocks</span>
                    </div>
                    {editMenuLoading && <p className="text-sm text-matter-neutral-500 italic">Loading menu…</p>}
                    {!editMenuLoading && (() => {
                      // Build date list from menu or existing selections
                      const mealPerDay = selectedCustomerDetail?.mealPerDay || 1;
                      const breakfastInclude = selectedCustomerDetail?.breakfastInclude || false;

                      // Collect all dates from the menu + draft
                      const allDates = new Set();
                      (editMenuData?.meals || []).forEach(m => {
                        if (m.date) allDates.add(m.date.split('T')[0]);
                      });
                      editDraft.forEach(m => {
                        const d = m.date ? (typeof m.date === 'string' ? m.date.split('T')[0] : new Date(m.date).toISOString().split('T')[0]) : null;
                        if (d) allDates.add(d);
                      });
                      const sortedDates = Array.from(allDates).sort();

                      if (sortedDates.length === 0) return <p className="text-matter-neutral-500 italic text-sm">No dates found.</p>;

                      // Build lookup: dateKey → { main: [items], breakfast: [items] } from menu
                      const menuItemsByDate = {};
                      (editMenuData?.meals || []).forEach(meal => {
                        const dk = meal.date ? meal.date.split('T')[0] : null;
                        if (!dk) return;
                        if (!menuItemsByDate[dk]) menuItemsByDate[dk] = { main: [], breakfast: [] };
                        const mealType = (meal.mealType || '').toLowerCase();
                        if (mealType === 'breakfast') {
                          (meal.items || []).forEach(it => menuItemsByDate[dk].breakfast.push(it));
                        } else if (mealType !== 'snack') {
                          (meal.items || []).forEach(it => menuItemsByDate[dk].main.push(it));
                        }
                      });

                      return sortedDates.map(dateKey => {
                        const dateLabel = (() => {
                          const [y, mo, d] = dateKey.split('-').map(Number);
                          return new Date(y, mo - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                        })();

                        const mainItems = menuItemsByDate[dateKey]?.main || [];
                        const bfItems = menuItemsByDate[dateKey]?.breakfast || [];

                        // Meals selected on this date (non-breakfast)
                        const mainDraft = editDraft.filter(m => {
                          const dk = m.date ? (typeof m.date === 'string' ? m.date.split('T')[0] : new Date(m.date).toISOString().split('T')[0]) : null;
                          return dk === dateKey && (m.mealType || '').toLowerCase() !== 'breakfast';
                        });
                        const bfDraft = editDraft.filter(m => {
                          const dk = m.date ? (typeof m.date === 'string' ? m.date.split('T')[0] : new Date(m.date).toISOString().split('T')[0]) : null;
                          return dk === dateKey && (m.mealType || '').toLowerCase() === 'breakfast';
                        });

                        const mainSlots = Array.from({ length: mealPerDay }, (_, i) => mainDraft[i] || null);
                        const bfSlots = breakfastInclude ? [bfDraft[0] || null] : [];

                        const renderSlot = (slotMeal, slotIndex, mealType, availableItems) => {
                          const slotKey = `${dateKey}|${mealType}|${slotIndex}`;
                          const isOpen = editOpenSlot === slotKey;
                          const isEmpty = !slotMeal;

                          return (
                            <div key={slotKey} className="relative" onClick={e => e.stopPropagation()}>
                              <div
                                onClick={() => setEditOpenSlot(isOpen ? null : slotKey)}
                                className={`rounded-xl border-2 p-3 cursor-pointer transition-all ${
                                  isEmpty
                                    ? 'border-dashed border-matter-neutral-300 bg-matter-neutral-100 text-matter-neutral-500'
                                    : 'border-matter-accent-300 bg-matter-accent-100 text-matter-navy hover:border-matter-sky'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2 min-h-[48px]">
                                  <div className="flex-1">
                                    {isEmpty ? (
                                      <span className="text-sm italic">Empty slot — click to add</span>
                                    ) : (
                                      <>
                                        <p className="text-sm font-bold leading-tight">{slotMeal.mealName}</p>
                                        <p className="text-xs text-matter-neutral-600 mt-0.5 capitalize">{slotMeal.mealType}</p>
                                      </>
                                    )}
                                  </div>
                                  {!isEmpty && (
                                    <button
                                      type="button"
                                      onClick={e => {
                                        e.stopPropagation();
                                        setEditDraft(prev => {
                                          const copy = [...prev];
                                          const globalIdx = prev.indexOf(slotMeal);
                                          if (globalIdx !== -1) copy.splice(globalIdx, 1);
                                          return copy;
                                        });
                                        setEditOpenSlot(null);
                                      }}
                                      className="text-red-400 hover:text-red-600 flex-shrink-0 p-0.5"
                                      title="Remove"
                                    >✕</button>
                                  )}
                                </div>
                                <div className="text-xs text-matter-sky mt-1">{isOpen ? '▲ close' : '▼ change'}</div>
                              </div>

                              {isOpen && (
                                <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-white border border-matter-neutral-300 rounded-xl shadow-xl max-h-64 overflow-y-auto">
                                  {availableItems.length === 0 && (
                                    <p className="text-sm text-matter-neutral-500 p-3 italic">No items in menu for this day</p>
                                  )}
                                  {availableItems.map(menuItem => (
                                    <button
                                      key={menuItem._id}
                                      type="button"
                                      onClick={() => {
                                        setEditDraft(prev => {
                                          const copy = [...prev];
                                          if (isEmpty) {
                                            // Add new entry
                                            copy.push({
                                              date: dateKey,
                                              mealType: menuItem.mealType || mealType,
                                              menuItemId: String(menuItem._id),
                                              mealName: menuItem.mealName,
                                              quantity: 1
                                            });
                                          } else {
                                            // Replace existing
                                            const globalIdx = prev.indexOf(slotMeal);
                                            if (globalIdx !== -1) {
                                              copy[globalIdx] = {
                                                ...copy[globalIdx],
                                                menuItemId: String(menuItem._id),
                                                mealName: menuItem.mealName,
                                                mealType: menuItem.mealType || mealType
                                              };
                                            }
                                          }
                                          return copy;
                                        });
                                        setEditOpenSlot(null);
                                      }}
                                      className="w-full text-left px-4 py-2.5 hover:bg-matter-accent-100 border-b border-matter-neutral-200 last:border-0"
                                    >
                                      <p className="text-sm font-semibold text-matter-navy">{menuItem.mealName}</p>
                                      <p className="text-xs text-matter-neutral-600 capitalize">{menuItem.mealType}</p>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        };

                        return (
                          <div key={dateKey} className="border border-matter-neutral-300 rounded-xl p-4">
                            <h4 className="text-sm font-bold text-matter-neutral-800 mb-3">{dateLabel}</h4>
                            <div className="grid grid-cols-2 gap-2">
                              {mainSlots.map((slot, i) => renderSlot(slot, i, 'main', mainItems))}
                              {bfSlots.map((slot, i) => renderSlot(slot, i, 'breakfast', bfItems))}
                            </div>
                          </div>
                        );
                      });
                    })()}
                    <div className="flex gap-2 pt-2">
                      <button
                        type="button"
                        disabled={editSaving}
                        onClick={async () => {
                          setEditSaving(true);
                          try {
                            const res = await api.put(
                              `/menus/${selectionMenuId}/selections/${encodeURIComponent(selectedCustomerDetail.email)}`,
                              { selections: editDraft }
                            );
                            if (res.data?.success) {
                              setSelectedCustomerDetail(prev => ({ ...prev, selectedMeals: editDraft }));
                              setIsEditingSelections(false);
                            } else {
                              alert(res.data?.message || 'Failed to save');
                            }
                          } catch (err) {
                            alert(err.response?.data?.message || 'Network error');
                          } finally {
                            setEditSaving(false);
                          }
                        }}
                        className="flex-1 bg-matter-navy hover:bg-matter-blueblack text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
                      >
                        {editSaving ? 'Saving…' : 'Save Changes'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setIsEditingSelections(false); setEditOpenSlot(null); }}
                        className="flex-1 border border-matter-neutral-300 text-matter-neutral-800 font-semibold py-2 px-4 rounded-lg hover:bg-matter-neutral-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                <div className="space-y-4">
                  {(() => {
                    const sourceDateKeys = Array.isArray(selectionDates) && selectionDates.length > 0
                      ? selectionDates.map((date) => getDateKey(date)).filter(Boolean)
                      : Array.from(new Set(
                          (selectedCustomerDetail.selectedMeals || []).map((meal) => {
                            const mealDate = meal.date || meal.menuItemId?.itemDate;
                            return getDateKey(mealDate);
                          }).filter(Boolean)
                        )).sort();

                    if (sourceDateKeys.length === 0) {
                      return (
                        <div className="text-center py-8 text-matter-neutral-600">
                          <p>No date information available</p>
                        </div>
                      );
                    }

                    const skippedByDate = new Map(
                      (selectedCustomerDetail.skippedDays || []).map((s) => [String(s.date || '').slice(0, 10), s])
                    );

                    return sourceDateKeys.map((key) => {
                      const skipInfo = skippedByDate.get(key);
                      const mealsForDate = (selectedCustomerDetail.selectedMeals || []).filter(m => {
                        const mealDate = m.date || m.menuItemId?.itemDate;
                        return getDateKey(mealDate) === key;
                      });
                      
                      // Consolidate duplicate meals
                      const consolidatedMap = new Map();
                      mealsForDate.forEach(meal => {
                        const itemId = String(meal.menuItemId?._id || meal.menuItemId || meal.mealName || '');
                        if (consolidatedMap.has(itemId)) {
                          const existing = consolidatedMap.get(itemId);
                          existing.quantity += (meal.quantity || 1);
                        } else {
                          consolidatedMap.set(itemId, {
                            ...meal,
                            quantity: meal.quantity || 1
                          });
                        }
                      });
                      
                      const mealsFor = Array.from(consolidatedMap.values());
                      const modalMenuDeadlines = menus.find(m => m._id === selectionMenuId)?.selectionDeadlines || [];
                      const modalDayIsLocked = isDateKeyLocked(key, modalMenuDeadlines);
                      const modalSubmittedAt = selectedCustomerDetail.lastMenuSelectionDate ? new Date(selectedCustomerDetail.lastMenuSelectionDate) : null;
                      const modalDeadlineForDay = getDeadlineDate(key, modalMenuDeadlines);
                      const modalSubmittedBeforeDeadline = modalSubmittedAt && modalDeadlineForDay && modalSubmittedAt <= modalDeadlineForDay;
                      const modalDayLocked = modalDayIsLocked && !modalSubmittedBeforeDeadline;
                      
                      // Helper function to get meal type styling and icon
                      const getMealStyle = (mealType) => {
                        const type = (mealType || '').toLowerCase();
                        if (type.includes('breakfast')) {
                          return {
                            bg: 'bg-matter-dust/40',
                            border: 'border-matter-dust',
                            text: 'text-matter-charcoal',
                            badge: 'bg-matter-dust/60 text-matter-charcoal',
                            icon: Coffee
                          };
                        } else if (type.includes('main')) {
                          return {
                            bg: 'bg-green-50',
                            border: 'border-green-200',
                            text: 'text-green-800',
                            badge: 'bg-green-100 text-green-700',
                            icon: Sandwich
                          };
                        } else if (type.includes('snack')) {
                          return {
                            bg: 'bg-matter-neutral-200',
                            border: 'border-matter-neutral-300',
                            text: 'text-matter-navy',
                            badge: 'bg-matter-accent-200 text-matter-navy',
                            icon: Cookie
                          };
                        }
                        return {
                          bg: 'bg-matter-neutral-100',
                          border: 'border-matter-neutral-300',
                          text: 'text-matter-navy',
                          badge: 'bg-matter-neutral-200 text-matter-neutral-800',
                          icon: Sandwich
                        };
                      };
                      
                      return (
                        <div key={key} className="bg-white border-2 border-matter-neutral-300 rounded-xl p-4 shadow-sm"> 
                          <div className="flex items-center gap-3 mb-4 pb-3 border-b border-matter-neutral-300">
                            <Calendar className="w-5 h-5 text-matter-sky" />
                            <h3 className="text-lg font-bold text-matter-navy">
                              {new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                            </h3>
                            <span className="ml-auto bg-matter-accent-200 text-matter-navy px-3 py-1 rounded-full text-sm font-semibold">
                              {mealsFor.reduce((sum, m) => sum + (m.quantity || 1), 0)} meal{mealsFor.reduce((sum, m) => sum + (m.quantity || 1), 0) === 1 ? '' : 's'}
                            </span>
                          </div>
                          {skipInfo && (
                            <div className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
                              skipInfo.pauseStatus === 'failed'
                                ? 'bg-red-50 border-red-200 text-red-700'
                                : skipInfo.pauseStatus === 'pending'
                                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                                  : 'bg-matter-dust/30 border-matter-dust text-matter-charcoal'
                            }`}>
                              <p className="font-semibold flex items-center gap-1.5">
                                <PauseCircle className="w-4 h-4" />
                                Customer skipped this day
                              </p>
                              {skipInfo.pauseStatus === 'success' && (
                                <p className="mt-0.5">Paused on Matter · resumes {skipInfo.resumeDate || 'after cycle end'}</p>
                              )}
                              {skipInfo.pauseStatus === 'already_paused' && (
                                <p className="mt-0.5">Already paused on the Matter subscription — no change made.</p>
                              )}
                              {skipInfo.pauseStatus === 'pending' && (
                                <p className="mt-0.5">Pause is being created on the Matter subscription…</p>
                              )}
                              {skipInfo.pauseStatus === 'failed' && (
                                <p className="mt-0.5">Pause failed: {skipInfo.error || 'Unknown error'}</p>
                              )}
                            </div>
                          )}
                          {mealsFor.length === 0 ? (
                            modalDayLocked ? (
                              <div className="text-sm text-matter-neutral-600 font-medium flex items-center gap-1 py-1">
                                🔒 Closed Day
                              </div>
                            ) : (
                              <div className="text-sm text-red-600 font-medium flex items-center gap-1 py-1">
                                <AlertCircle className="w-4 h-4" />
                                No meal selection
                              </div>
                            )
                          ) : (
                          <div className="grid gap-3">
                            {mealsFor.map((meal, idx) => {
                              const mealStyle = getMealStyle(meal.mealType || meal.menuItemId?.mealType);
                              const MealIcon = mealStyle.icon;
                              const ingredients = meal.menuItemId?.ingredients || meal.ingredients || '';
                              const carbs = meal.menuItemId?.carbs || meal.carbs || '';
                              const veg = meal.menuItemId?.veg || meal.veg || '';
                              
                              return (
                                <div
                                  key={idx}
                                  className={`${mealStyle.bg} ${mealStyle.border} border-l-4 rounded-lg p-4 shadow-sm`}
                                >
                                  <div className="flex items-start gap-3">
                                    <div className={`${mealStyle.bg} p-2 rounded-lg`}>
                                      <MealIcon className={`w-6 h-6 ${mealStyle.text}`} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-start justify-between gap-2 mb-2">
                                        <h4 className="font-bold text-lg text-matter-navy">
                                          {meal.mealName || meal.menuItemId?.mealName || 'Meal'}
                                        </h4>
                                        {meal.quantity > 1 && (
                                          <span className="bg-matter-accent-100 text-matter-accent-800 px-3 py-1 rounded-full text-sm font-bold flex-shrink-0">
                                            Qty: {meal.quantity}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-2 mb-3 flex-wrap">
                                        <span className={`text-sm font-semibold px-3 py-1 rounded-full ${mealStyle.badge}`}>
                                          {meal.mealType || meal.menuItemId?.mealType || 'meal'}
                                        </span>
                                        {meal.carbVegAction === 'replace' && (
                                          <span className="text-sm font-bold bg-red-100 text-red-700 px-3 py-1 rounded-full">
                                            🔄 Replace carb/veg
                                          </span>
                                        )}
                                        {meal.carbVegAction === 'kept' && (
                                          <span className="text-sm font-bold bg-green-100 text-green-700 px-3 py-1 rounded-full">
                                            ✓ Keep carb/veg
                                          </span>
                                        )}
                                        {meal.conflict && (
                                          <span className="text-sm font-bold bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full">
                                            ⚠️ Exclusion
                                          </span>
                                        )}
                                      </div>
                                      {meal.carbVegConflict?.length > 0 && (
                                        <div className="flex gap-2 text-sm mb-2">
                                          <span className="font-semibold text-matter-neutral-800 min-w-[80px]">Conflict:</span>
                                          <span className="text-matter-neutral-700">{meal.carbVegConflict.join(', ')}</span>
                                        </div>
                                      )}
                                      {(ingredients || carbs || veg) && (
                                        <div className="space-y-1.5 text-sm">
                                          {ingredients && (
                                            <div className="flex gap-2">
                                              <span className="font-semibold text-matter-neutral-800 min-w-[80px]">Ingredients:</span>
                                              <span className="text-matter-neutral-700">{ingredients}</span>
                                            </div>
                                          )}
                                          {carbs && (
                                            <div className="flex gap-2">
                                              <span className="font-semibold text-matter-neutral-800 min-w-[80px]">Carbs:</span>
                                              <span className="text-matter-neutral-700">{carbs}</span>
                                            </div>
                                          )}
                                          {veg && (
                                            <div className="flex gap-2">
                                              <span className="font-semibold text-matter-neutral-800 min-w-[80px]">Vegetables:</span>
                                              <span className="text-matter-neutral-700">{veg}</span>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
                )}
            </div>
            </div>

            {/* Modal Footer */}
            <div className="bg-matter-neutral-100 px-6 py-4 border-t border-matter-neutral-300">
              <button
                onClick={() => setSelectedCustomerDetail(null)}
                className="w-full bg-matter-navy hover:bg-matter-blueblack text-white font-semibold py-3 px-4 rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preset Macros Modal */}
      {showPresetMacroModal && selectedCustomerDetail && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-[60]" onClick={() => setShowPresetMacroModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-matter-navy to-matter-sky text-white px-6 py-4 rounded-t-xl flex items-center justify-between">
              <h3 className="text-lg font-bold">Breakfast & Snack Presets</h3>
              <button onClick={() => setShowPresetMacroModal(false)} className="hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-6">
              {[
                { key: 'breakfast', label: 'Breakfast', icon: <Coffee className="w-4 h-4" /> },
                { key: 'snack', label: 'Snack', icon: <Cookie className="w-4 h-4" /> }
              ].map(({ key, label, icon }) => (
                <div key={key}>
                  <div className="flex items-center gap-2 mb-3">
                    {icon}
                    <span className="font-semibold text-matter-navy">{label}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {['C', 'P', 'F'].map((macro) => (
                      <div key={macro}>
                        <label className="block text-xs font-medium text-matter-neutral-600 mb-1">
                          {macro === 'C' ? 'Carbs (g)' : macro === 'P' ? 'Protein (g)' : 'Fat (g)'}
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={presetMacroForm[key][macro]}
                          onChange={(e) => setPresetMacroForm(prev => ({
                            ...prev,
                            [key]: { ...prev[key], [macro]: e.target.value }
                          }))}
                          className="w-full border border-matter-neutral-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-matter-sky focus:border-transparent"
                          placeholder="0"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button
                onClick={() => setShowPresetMacroModal(false)}
                className="flex-1 border border-matter-neutral-300 text-matter-neutral-800 rounded-lg py-2 text-sm font-medium hover:bg-matter-neutral-100 transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={savingPresetMacros}
                onClick={async () => {
                  setSavingPresetMacros(true);
                  try {
                    const toNum = (v) => v === '' ? undefined : Number(v);
                    const breakfast = {
                      C: toNum(presetMacroForm.breakfast.C),
                      P: toNum(presetMacroForm.breakfast.P),
                      F: toNum(presetMacroForm.breakfast.F)
                    };
                    const snack = {
                      C: toNum(presetMacroForm.snack.C),
                      P: toNum(presetMacroForm.snack.P),
                      F: toNum(presetMacroForm.snack.F)
                    };
                    await api.patch(
                      `/menus/${selectionMenuId}/selections/${encodeURIComponent(selectedCustomerDetail.email)}/macros-presets`,
                      { breakfast, snack }
                    );
                    setSelectedCustomerDetail(prev => ({
                      ...prev,
                      macros: {
                        ...prev.macros,
                        presets: { breakfast, snack }
                      }
                    }));
                    setShowPresetMacroModal(false);
                  } catch (err) {
                    alert('Failed to save presets: ' + (err.response?.data?.message || err.message));
                  } finally {
                    setSavingPresetMacros(false);
                  }
                }}
                className="flex-1 bg-matter-navy hover:bg-matter-blueblack text-white rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-50"
              >
                {savingPresetMacros ? 'Saving…' : 'Save Presets'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MenuManagement;
