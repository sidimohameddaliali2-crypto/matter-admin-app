import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useSelector } from 'react-redux';
import api from '../utils/api';
import * as XLSX from 'xlsx';
import { parseGPSFromLink as enhancedParseGPSFromLink } from '../utils/gpsParsing';

const MS_PER_MINUTE = 60 * 1000;
const LOCAL_TIMEZONE_OFFSET_MINUTES = Number(
  process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES ?? process.env.LOCAL_TIMEZONE_OFFSET_MINUTES ?? 0
);
const HAS_DEFINED_LOCAL_OFFSET = Number.isFinite(LOCAL_TIMEZONE_OFFSET_MINUTES);

const buildUtcFromLocalComponents = (
  year,
  monthIndex,
  day,
  hours = 0,
  minutes = 0,
  seconds = 0,
  milliseconds = 0
) => {
  const baseUtc = Date.UTC(year, monthIndex, day, hours, minutes, seconds, milliseconds);
  if (!HAS_DEFINED_LOCAL_OFFSET) {
    return Number.isNaN(baseUtc) ? null : new Date(baseUtc);
  }
  const adjusted = baseUtc - LOCAL_TIMEZONE_OFFSET_MINUTES * MS_PER_MINUTE;
  return Number.isNaN(adjusted) ? null : new Date(adjusted);
};

const parseExcelSerialToDate = (numericValue) => {
  if (!numericValue || Number.isNaN(Number(numericValue))) {
    return null;
  }

  const dateCode = XLSX.SSF.parse_date_code(Number(numericValue));
  if (!dateCode) {
    return null;
  }

  return buildUtcFromLocalComponents(
    dateCode.y,
    (dateCode.m || 1) - 1,
    dateCode.d || 1,
    dateCode.H || 0,
    dateCode.M || 0,
    Math.floor(dateCode.S || 0)
  );
};

const reconstructFromDate = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }

  return buildUtcFromLocalComponents(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
};

const tryParseStringDate = (value) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const explicitTimezone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);

  const candidates = [
    trimmed,
    trimmed.replace(/\s+/g, ' '),
    trimmed.replace(/\//g, '-'),
    trimmed.replace(/\//g, '-').replace(/\s+/, 'T'),
  ];

  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return explicitTimezone ? parsed : reconstructFromDate(parsed);
    }
  }

  // Attempt manual parsing for formats like DD/MM/YYYY HH:mm:ss AM
  const match = trimmed.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i
  );
  if (match) {
    let [_, part1, part2, part3, hh, mm, ss = '0', meridiem] = match;
    let day = Number(part1);
    let month = Number(part2);
    let year = Number(part3);

    if (year < 100) {
      year += 2000;
    } else if (year < 1000) {
      year += 2000;
    }

    // Assume format is DD/MM/YYYY unless month would be invalid
    if (month > 12 && day <= 12) {
      [day, month] = [month, day];
    }

    let hours = Number(hh);
    const minutes = Number(mm);
    const seconds = Number(ss);
    if (meridiem) {
      const upper = meridiem.toUpperCase();
      if (upper === 'PM' && hours < 12) {
        hours += 12;
      }
      if (upper === 'AM' && hours === 12) {
        hours = 0;
      }
    }

    return buildUtcFromLocalComponents(year, month - 1, day, hours, minutes, seconds);
  }

  return null;
};

const parseDateTimeValue = (rawValue) => {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return null;
  }

  if (rawValue instanceof Date) {
    return reconstructFromDate(rawValue);
  }

  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return parseExcelSerialToDate(rawValue);
  }

  if (typeof rawValue === 'string') {
    return tryParseStringDate(rawValue);
  }

  return null;
};

// Helper function to apply pending changes after delivery creation
// Enhanced helper function to apply pending changes after delivery creation
const applyPendingChanges = async (delivery) => {
  try {
    if (!delivery || !delivery.customerId || !delivery.scheduledTime) {
      console.warn('applyPendingChanges called with invalid delivery:', delivery);
      return 0;
    }
    console.log('Checking for pending changes for delivery:', {
      customerId: delivery.customerId,
      scheduledTime: delivery.scheduledTime
    });

    // Extract just the date part (YYYY-MM-DD) from the scheduledTime
    const scheduledDate = new Date(delivery.scheduledTime);
    const dateString = scheduledDate.toISOString().split('T')[0];
    
    console.log('Formatted date for pending changes search:', dateString);

    // Check for pending changes for this customer and date
    const response = await api.get('/delivery-changes/pending', {
      params: {
        customerId: delivery.customerId,
        scheduledDate: dateString
      }
    });

    const pendingChanges = response.data.changes || [];
    console.log(`Found ${pendingChanges.length} pending changes for customer ${delivery.customerId} on ${dateString}`);

    let appliedCount = 0;

    for (const change of pendingChanges) {
      try {
        console.log('Processing pending change:', change._id, 'for delivery:', delivery._id);
        
        // Use the apply endpoint instead of direct update
        const applyResponse = await api.post(`/delivery-changes/${change._id}/apply`);
        
        if (applyResponse.data.success) {
          appliedCount++;
          console.log(`✅ Successfully applied change ${change._id} to delivery ${delivery._id}`);
        } else {
          console.error(`❌ Failed to apply change ${change._id}:`, applyResponse.data.message);
        }
      } catch (error) {
        console.error(`❌ Error applying change ${change._id}:`, error.response?.data || error.message);
      }
    }

    console.log(`Applied ${appliedCount} out of ${pendingChanges.length} pending changes`);
    return appliedCount;
  } catch (error) {
    console.error('❌ Error checking for pending changes:', error.response?.data || error.message);
    return 0;
  }
};

// The native browser <input type="datetime-local"> time-of-day picker (the
// scroll-wheel hour/minute/AM-PM widget) is unreliable on mobile — the
// committed value can end up several hours off from what was actually
// scrolled to. Hour-only selects sidestep that entirely, and minutes are
// always forced to :00 since deliveries are never scheduled to the minute.
const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

const splitScheduledTimeLocal = (value) => {
  if (!value) return { date: '', hour12: '', period: 'AM' };
  const [datePart, timePart] = value.split('T');
  const [hStr] = (timePart || '00:00').split(':');
  const h = Number(hStr);
  if (!Number.isFinite(h)) return { date: datePart || '', hour12: '', period: 'AM' };
  const period = h >= 12 ? 'PM' : 'AM';
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return { date: datePart || '', hour12: String(hour12), period };
};

const buildScheduledTimeLocal = (date, hour12, period) => {
  if (!date || !hour12) return '';
  let h = parseInt(hour12, 10) % 12;
  if (period === 'PM') h += 12;
  return `${date}T${String(h).padStart(2, '0')}:00`;
};

const SCHEDULED_TIME_INPUT_CLS = 'w-full bg-gray-50 border border-gray-200 rounded py-2 px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white transition-colors';
const SCHEDULED_TIME_LABEL_CLS = 'block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5';

function ScheduledTimeField({ value, onChange, label, hint, name = 'scheduledTime', required = true }) {
  // buildScheduledTimeLocal only returns a value once date AND hour are both
  // set, so picking Hour before Date (or vice versa) produces '' — if this
  // field just re-derived its displayed values from that '' every render, an
  // in-progress pick would immediately snap back to blank. Local state keeps
  // whatever the user picked visible; it's only resynced from the parent
  // `value` when that prop changes for a reason other than our own emit
  // (e.g. loading a different delivery, or an external form reset).
  const [local, setLocal] = useState(() => splitScheduledTimeLocal(value));
  const lastEmittedRef = React.useRef(value);

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      setLocal(splitScheduledTimeLocal(value));
      lastEmittedRef.current = value;
    }
  }, [value]);

  const { date, hour12, period } = local;

  const emit = (nextDate, nextHour, nextPeriod) => {
    setLocal({ date: nextDate, hour12: nextHour, period: nextPeriod });
    const built = buildScheduledTimeLocal(nextDate, nextHour, nextPeriod);
    lastEmittedRef.current = built;
    onChange({ target: { name, value: built } });
  };

  return (
    <div>
      {label && <label className={SCHEDULED_TIME_LABEL_CLS}>{label}</label>}
      <div className="grid grid-cols-3 gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => emit(e.target.value, hour12, period)}
          required={required}
          className={SCHEDULED_TIME_INPUT_CLS}
        />
        <select
          value={hour12}
          onChange={(e) => emit(date, e.target.value, period)}
          required={required}
          className={`${SCHEDULED_TIME_INPUT_CLS} appearance-none`}
        >
          <option value="">Hour</option>
          {HOUR_OPTIONS.map((h) => (
            <option key={h} value={h}>{h}:00</option>
          ))}
        </select>
        <select
          value={period}
          onChange={(e) => emit(date, hour12, e.target.value)}
          className={`${SCHEDULED_TIME_INPUT_CLS} appearance-none`}
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      </div>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

const AddDelivery = () => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('manual');
  const [drivers, setDrivers] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [importData, setImportData] = useState([]);
  const [validationErrors, setValidationErrors] = useState([]);
  const [fileName, setFileName] = useState('');
  const [importProgress, setImportProgress] = useState({
    total: 0,
    processed: 0,
    success: 0,
    error: 0,
    inProgress: false
  });
  const [pastedData, setPastedData] = useState('');
  // Applied to any imported row that doesn't specify its own "Location Type" column.
  const [bulkLocationType, setBulkLocationType] = useState('');
  const { user } = useSelector(state => state.auth);

  const [formData, setFormData] = useState({
    customerId: 'CUST-',
    customerName: '',
    scheduledTime: '',
    driver: '',
    company: 'Matter',
    otherCompany: '',
    type: 'Delivery',
    taskType: 'Purchase', // For task tab
    todoList: [], // For task tab
    requireProof: true, // For task tab
    address: '',
    zone: '',
    gpsLocation: {
      lat: '',
      lng: '',
      link: ''
    },
    notes: ''
  });

  const [todoInput, setTodoInput] = useState('');

  // Collection state
  const [collectionBagIds, setCollectionBagIds] = useState(['']);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const customerCacheRef = React.useRef(null);
  const searchDebounceRef = React.useRef(null);

  useEffect(() => {
    fetchDrivers();
  }, []);

  const fetchDrivers = async () => {
    try {
      const response = await api.get('/users/drivers');
      const payload = response?.data;
      const driversList =
        payload?.data?.users ||
        payload?.data?.drivers ||
        payload?.data ||
        payload?.users ||
        payload?.drivers ||
        payload ||
        [];

      setDrivers(Array.isArray(driversList) ? driversList : []);
    } catch (error) {
      console.error('Error fetching drivers:', error);
    }
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!user || user.role !== 'admin') {
      alert('Only admins can create deliveries');
      return;
    }

    setIsSubmitting(true);
    try {
      // Prepare delivery data based on type
      let deliveryData = {
        customerId: formData.customerId,
        customerName: formData.customerName,
        scheduledTime: formData.scheduledTime,
        company: formData.company === 'Other' ? formData.otherCompany : formData.company,
        address: formData.address,
        zone: formData.zone,
        notes: formData.notes,
        type: formData.type
      };

      // Add gpsLocation if provided
      if (formData.gpsLocation?.lat && formData.gpsLocation?.lng) {
        deliveryData.gpsLocation = formData.gpsLocation;
      }

      // Add driver if selected
      if (formData.driver) {
        deliveryData.driver = formData.driver;
      }

      // Add task-specific fields if type is Task
      if (formData.type === 'Task') {
        deliveryData.taskType = formData.taskType;
        deliveryData.requireProof = formData.requireProof;
        deliveryData.todoList = formData.todoList;
      }

      // Add collection-specific fields if type is Collection
      if (formData.type === 'Collection') {
        const validBagIds = collectionBagIds.map(b => b.trim()).filter(Boolean);
        deliveryData.collectionDetails = { bagIds: validBagIds };
        // address is optional for collections
        deliveryData.address = formData.address || '';
      }

      console.log('Submitting delivery/task data:', deliveryData);

      const response = await api.post('/deliveries', deliveryData);

      if (response.data.success) {
        const createdDelivery = response?.data?.data?.delivery || response?.data?.delivery;
        if (!createdDelivery) {
          console.warn('Create delivery response missing delivery payload:', response.data);
        }
        
        // Server automatically applies pending changes, no need for client-side application
        
        let successMessage = formData.type === 'Task'
          ? 'Task created successfully!'
          : formData.type === 'Collection'
          ? 'Collection created successfully!'
          : 'Delivery created successfully!';
        alert(successMessage);
        navigate(-1);
      } else {
        throw new Error(response.data.message);
      }
    } catch (error) {
      console.error('Error creating delivery:', error);
      
      // Better error display
      let errorMessage = 'Failed to create ' + (formData.type === 'Task' ? 'task' : formData.type === 'Collection' ? 'collection' : 'delivery');
      if (error.response?.data?.errors) {
        const validationErrors = error.response.data.errors.map(e => `${e.path}: ${e.msg}`).join('\n');
        errorMessage += '\n\nValidation errors:\n' + validationErrors;
      } else if (error.response?.data?.message) {
        errorMessage += '\n\n' + error.response.data.message;
      } else if (error.message) {
        errorMessage += '\n\n' + error.message;
      }
      
      alert(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = e => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const addTodoItem = () => {
    if (todoInput.trim()) {
      setFormData(prev => ({
        ...prev,
        todoList: [...prev.todoList, { text: todoInput.trim(), completed: false }]
      }));
      setTodoInput('');
    }
  };

  const removeTodoItem = (index) => {
    setFormData(prev => ({
      ...prev,
      todoList: prev.todoList.filter((_, i) => i !== index)
    }));
  };

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    // Set type based on active tab
    if (tab === 'manual') {
      setFormData(prev => ({ ...prev, type: 'Delivery' }));
    } else if (tab === 'task') {
      setFormData(prev => ({ ...prev, type: 'Task' }));
    } else if (tab === 'bulk') {
      setFormData(prev => ({ ...prev, type: 'Delivery' }));
    } else if (tab === 'collection') {
      setFormData(prev => ({ ...prev, type: 'Collection' }));
      // Pre-load customer list into cache so search is instant
      if (!customerCacheRef.current) {
        api.get('/customers', { params: { limit: 500 } }).then(res => {
          customerCacheRef.current = res?.data?.data || [];
        }).catch(() => {});
      }
    }
  };

  const searchCustomers = (query) => {
    clearTimeout(searchDebounceRef.current);
    if (!query || query.trim().length < 2) {
      setCustomerResults([]);
      setShowCustomerDropdown(false);
      return;
    }

    const runFilter = async () => {
      // Ensure cache is populated
      if (!customerCacheRef.current) {
        setCustomerSearchLoading(true);
        try {
          const res = await api.get('/customers', { params: { limit: 500 } });
          customerCacheRef.current = res?.data?.data || [];
        } catch (err) {
          console.error('Customer load error:', err);
          setCustomerSearchLoading(false);
          return;
        }
        setCustomerSearchLoading(false);
      }

      const q = query.trim().toLowerCase();
      const filtered = customerCacheRef.current.filter(c =>
        (c.customerId || '').toLowerCase().includes(q) ||
        (c.firstName || '').toLowerCase().includes(q) ||
        (c.lastName || '').toLowerCase().includes(q) ||
        (`${c.firstName || ''} ${c.lastName || ''}`).toLowerCase().includes(q)
      ).slice(0, 10);
      setCustomerResults(filtered);
      setShowCustomerDropdown(filtered.length > 0);
    };

    searchDebounceRef.current = setTimeout(runFilter, 150);
  };

  const selectCustomer = (customer) => {
    const name = `${customer.firstName || ''} ${customer.lastName || ''}`.trim();
    setFormData(prev => ({
      ...prev,
      customerId: customer.customerId || '',
      customerName: name
    }));
    setCustomerSearch(name + (customer.customerId ? ` (${customer.customerId})` : ''));
    setShowCustomerDropdown(false);
    setCustomerResults([]);

    // Auto-fetch location from most recent delivery for this customer
    if (customer.customerId) {
      api.get(`/customers/${encodeURIComponent(customer.customerId)}/location`)
        .then(res => {
          const loc = res?.data?.data;
          if (!loc) return;
          setFormData(prev => ({
            ...prev,
            address: loc.address || prev.address,
            zone: loc.zone || prev.zone,
            gpsLocation: loc.gpsLocation
              ? { lat: loc.gpsLocation.lat || '', lng: loc.gpsLocation.lng || '', link: loc.gpsLocation.link || '' }
              : prev.gpsLocation
          }));
        })
        .catch(() => {}); // non-blocking
    }
  };

  const addBagIdField = () => setCollectionBagIds(prev => [...prev, '']);
  const removeBagIdField = (index) => setCollectionBagIds(prev => prev.filter((_, i) => i !== index));
  const updateBagId = (index, value) => setCollectionBagIds(prev => prev.map((b, i) => i === index ? value : b));

  const handleFileUpload = e => {
    const file = e.target.files[0];
    if (!file) return;

    setFileName(file.name);
    setValidationErrors([]);
    setImportData([]);
    setImportProgress({
      total: 0,
      processed: 0,
      success: 0,
      error: 0,
      inProgress: false
    });

    const reader = new FileReader();

    reader.onload = event => {
      try {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        if (jsonData.length < 2) {
          setValidationErrors(['File is empty or has no data']);
          return;
        }

        processImportedData(jsonData);
      } catch (errorReading) {
        console.error('Error reading file:', errorReading);
        setValidationErrors(["Error reading file. Please make sure it's a valid Excel file."]);
      }
    };

    reader.onerror = () => {
      setValidationErrors(['Error reading file']);
    };

    reader.readAsArrayBuffer(file);
  };

  // Parses a structured location string like:
  // "City: DUBAI\nArea: Alkhawaneej 2\nStreet: Alsamr street\nBuilding: House 41\nFloor: 0\nApartment: 41"
  // Returns an object with named fields, or null if the format is not detected.
  const parseStructuredAddress = (value) => {
    if (!value || typeof value !== 'string') return null;
    const lower = value.toLowerCase();
    // Must contain at least "city:" and "area:" to be considered structured
    if (!lower.includes('city:') || !lower.includes('area:')) return null;

    const extract = (label) => {
      const match = value.match(new RegExp(`${label}\\s*:\\s*(.+)`, 'i'));
      return match ? match[1].trim() : '';
    };

    return {
      city: extract('city'),
      area: extract('area'),
      street: extract('street'),
      building: extract('building'),
      floor: extract('floor'),
      apartment: extract('apartment')
    };
  };

  // Maps free-text "Location Type" cell values to the two categories the
  // backend accepts. Unrecognized/blank values fall through to the batch-wide
  // default selected above the upload area.
  const normalizeLocationTypeValue = (value) => {
    const cleaned = String(value || '').trim().toLowerCase();
    if (['villa', 'house', 'townhouse', 'v'].includes(cleaned)) return 'Villa';
    if (['apartment', 'apt', 'flat', 'a'].includes(cleaned)) return 'Apartment';
    return '';
  };

  const processImportedData = data => {
    const headers = data[0].map(h => h?.toString().trim().toLowerCase() || '');
    const rows = data.slice(1);
    const processedData = [];
    const errors = [];

    const headerMap = {
      'customer id': 'customerId',
      'customer name': 'customerName',
      name: 'customerName',
      'scheduled time': 'scheduledTime',
      'delivery time and date': 'scheduledTime',
      location: 'address',
      address: 'address',
      area: 'zone',
      zone: 'zone',
      driver: 'driverName',
      gps: 'gpsLink',
      company: 'company',
      notes: 'notes',
      type: 'type',
      'location type': 'locationType',
      'property type': 'locationType',
      'villa/apartment': 'locationType',
      'villa or apartment': 'locationType'
    };

    const requiredHeaderGroups = [
      ['customer id'],
      ['name', 'customer name'],
      ['delivery time and date', 'scheduled time'],
      ['location', 'address']
    ];

    const missingHeaders = requiredHeaderGroups
      .filter(group => !group.some(header => headers.includes(header)))
      .map(group => group[0]);

    if (missingHeaders.length > 0) {
      errors.push(`Missing required columns: ${missingHeaders.join(', ')}`);
      setValidationErrors(errors);
      return;
    }

    rows.forEach((row, index) => {
      const isEmptyRow = row.every(
        cell => cell === undefined || cell === null || cell.toString().trim() === ''
      );
      if (isEmptyRow) return;

      const rowData = {};
      const rowErrors = [];

      headers.forEach((header, colIndex) => {
        const rawValue = row[colIndex];
        const stringValue =
          rawValue === undefined || rawValue === null ? '' : rawValue.toString().trim();
        const mappedHeader = headerMap[header];

        if (!mappedHeader) {
          return;
        }

        if (mappedHeader === 'scheduledTime') {
          rowData[mappedHeader] =
            rawValue !== undefined && rawValue !== null && rawValue !== ''
              ? rawValue
              : stringValue;
        } else {
          rowData[mappedHeader] = stringValue;
        }
      });

      // Parse structured address from "Location" column if applicable
      if (rowData.address) {
        const structured = parseStructuredAddress(rowData.address);
        if (structured) {
          // Compose a flat address string from the structured parts
          const parts = [
            structured.building,
            structured.street,
            structured.apartment ? `Apt ${structured.apartment}` : '',
            structured.area,
            structured.city
          ].filter(p => p && p.trim() && p.trim() !== '0');
          rowData.address = parts.join(', ');
          rowData.addressDetails = structured;
          // Use area as zone for auto-detection
          if (!rowData.zone && structured.area) {
            rowData.zone = structured.area;
          }
        }
      }

      if (!rowData.customerId) rowErrors.push('Customer ID is required');
      if (!rowData.customerName) rowErrors.push('Customer Name is required');
      const hasScheduledTimeValue =
        rowData.scheduledTime !== undefined && rowData.scheduledTime !== null && rowData.scheduledTime !== '';
      if (!hasScheduledTimeValue) rowErrors.push('Scheduled Time is required');
      if (!rowData.address) rowErrors.push('Address is required');

      if (hasScheduledTimeValue) {
        const parsedDate = parseDateTimeValue(rowData.scheduledTime);

        if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
          rowErrors.push('Invalid Scheduled Time format');
        } else {
          rowData.scheduledTime = parsedDate.toISOString();
        }
      }

      // Preserve company as provided in sheet; default to Matter when empty
      const rawCompany = rowData.company && rowData.company.trim() ? rowData.company.trim() : '';
      rowData.company = rawCompany || 'Matter';

      if (rowData.driverName) {
        const inputDriverName = rowData.driverName.trim();
        const normalizedDriver = inputDriverName.toLowerCase();
        const driverMatch = drivers.find(d => {
          const firstName = d?.profile?.firstName?.trim().toLowerCase();
          const fullName = `${d?.profile?.firstName || ''} ${d?.profile?.lastName || ''}`
            .trim()
            .toLowerCase();
          return firstName === normalizedDriver || fullName === normalizedDriver;
        });
        if (driverMatch?._id) {
          rowData.driver = driverMatch._id;
          rowData.driverName = `${driverMatch.profile.firstName} ${driverMatch.profile.lastName}`.trim();
        } else {
          rowData.driver = undefined;
          rowData.driverName = inputDriverName;
        }
      }

      if (rowData.gpsLink) {
        let gpsLocation = null;
        const extracted = enhancedParseGPSFromLink(rowData.gpsLink);
        if (extracted) {
          gpsLocation = {
            lat: extracted.lat,
            lng: extracted.lng,
            link: rowData.gpsLink
          };
        } else {
          const coords = rowData.gpsLink.split(',').map(part => parseFloat(part.trim()));
          if (coords.length === 2 && coords.every(coord => !Number.isNaN(coord))) {
            gpsLocation = {
              lat: coords[0],
              lng: coords[1],
              link: ''
            };
          }
        }

        rowData.gpsLocation = gpsLocation || {
          lat: '',
          lng: '',
          link: rowData.gpsLink
        };
      }

      if (rowData.address) rowData.address = rowData.address.trim();
      if (rowData.customerName) rowData.customerName = rowData.customerName.trim();
      if (rowData.zone) rowData.zone = rowData.zone.trim();
      // Blank/unrecognized cell -> '' so the batch-wide default applies at submit time.
      rowData.locationType = normalizeLocationTypeValue(rowData.locationType);

      if (rowErrors.length === 0) {
        processedData.push({
          ...rowData,
          gpsLocation: rowData.gpsLocation,
          _id: `temp-${index}`,
          status: 'valid'
        });
      } else {
        errors.push(`Row ${index + 2}: ${rowErrors.join(', ')}`);
      }
    });

    setImportData(processedData);
    setValidationErrors(errors);

    if (errors.length > 0) {
      alert(`Found ${errors.length} error(s) in the file. Please check the validation errors below.`);
    }
  };

  const handleImportSubmit = async () => {
    if (importData.length === 0) {
      return;
    }

    setImportProgress({
      total: importData.length,
      processed: 0,
      success: 0,
      error: 0,
      inProgress: true
    });
    setIsSubmitting(true);
    try {
      // Prepare all deliveries for bulk creation
      const bulkPayload = {
        deliveries: importData.map(delivery => {
          const payload = {
            customerId: delivery.customerId,
            customerName: delivery.customerName,
            scheduledTime: delivery.scheduledTime,
            company: (() => {
              const raw = (delivery.company || '').trim();
              return raw || 'Matter';
            })(),
            type: delivery.type || 'Delivery',
            address: delivery.address || '',
            zone: delivery.zone || '',
            notes: delivery.notes || '',
            status: 'pending'
          };

          const resolvedLocationType = delivery.locationType || bulkLocationType || '';
          if (delivery.addressDetails || resolvedLocationType) {
            payload.addressDetails = {
              ...(delivery.addressDetails || {}),
              ...(resolvedLocationType ? { locationType: resolvedLocationType } : {})
            };
          }

          if (delivery.driver) {
            payload.driver = delivery.driver;
          }

          const gpsLocation = delivery.gpsLocation || null;
          if (gpsLocation && (gpsLocation.lat || gpsLocation.lng || gpsLocation.link)) {
            payload.gpsLocation = {
              lat: gpsLocation.lat || '',
              lng: gpsLocation.lng || '',
              link: gpsLocation.link || ''
            };
          } else if (delivery.gpsLink) {
            payload.gpsLocation = {
              lat: '',
              lng: '',
              link: delivery.gpsLink
            };
          }

          return payload;
        })
      };

      console.log(`📦 Starting bulk import of ${importData.length} deliveries...`);
      const startTime = Date.now();

      // Send all deliveries in a single request
      const response = await api.post('/deliveries/bulk', bulkPayload);

      const elapsedMs = Date.now() - startTime;
      const elapsedSec = (elapsedMs / 1000).toFixed(2);

      if (response.data?.success) {
        const createdCount = response.data?.data?.totalCreated || importData.length;
        const changesApplied = response.data?.data?.changesApplied || 0;
        const withoutPin = response.data?.data?.withoutPin || 0;

        console.log(`✅ Bulk import completed in ${elapsedSec}s`);
        console.log(`   - Created: ${createdCount} deliveries`);
        console.log(`   - Changes applied: ${changesApplied}`);
        console.log(`   - Server processing: ${response.data?.data?.processingTimeMs}ms`);

        setImportProgress({
          total: importData.length,
          processed: importData.length,
          success: createdCount,
          error: 0,
          inProgress: false
        });

        let successMessage = `✅ Successfully imported ${createdCount} deliveries in ${elapsedSec}s`;
        if (changesApplied > 0) {
          successMessage += ` with ${changesApplied} pending changes applied`;
        }
        if (withoutPin > 0) {
          successMessage += `\n\n${withoutPin} of them have no map pin yet — place them on Driver Routes before optimizing.`;
        }
        alert(successMessage);

        // Clear import data after successful import
        setImportData([]);
        setPastedData('');
        setValidationErrors([]);
      } else {
        console.error('Bulk import failed:', response.data);
        const errorMessage = response.data?.message || 'Unknown error during bulk import';
        setValidationErrors([`Bulk import failed: ${errorMessage}`]);
        setImportProgress({
          total: importData.length,
          processed: 0,
          success: 0,
          error: importData.length,
          inProgress: false
        });
      }
    } catch (error) {
      console.error('❌ Bulk import error:', error);
      const errorMessage = 
        error.response?.data?.message || 
        error.message || 
        'Unknown error during bulk import';
      setValidationErrors([`Bulk import failed: ${errorMessage}`]);
      setImportProgress(prev => ({
        ...prev,
        inProgress: false,
        error: prev.total
      }));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNestedChange = e => {
    const { name, value } = e.target;

    if (name.includes('.')) {
      const [parent, child] = name.split('.');

      setFormData(prev => ({
        ...prev,
        [parent]: {
          ...prev[parent],
          [child]: value
        }
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        [name]: value
      }));
    }
  };

  const downloadTemplate = () => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const templateData = [
      ['Customer ID', 'Name', 'Delivery Time and Date', 'Location', 'Area', 'Driver', 'GPS', 'Company', 'Location Type'],
      ['CUST001', 'John Doe', `${today} 09:00`, '123 Main St, New York, NY', 'Midtown', 'John Smith', 'https://maps.google.com/?q=40.758,-73.9855', 'Matter', 'Apartment'],
      ['CUST002', 'Jane Smith', `${today} 14:30`, '456 Oak Ave, Chicago, IL', 'North Side', 'Sarah Johnson', '41.8818,-87.6231', 'Yellow Block', 'Villa'],
      ['CUST003', 'Bob Wilson', `${tomorrow} 10:00`, '789 Pine Rd, Los Angeles, CA', 'Westwood', 'Mike Brown', '', 'CookIt', ''],
      [
        'Required',
        'Required',
        'Required - use date and time (example: 2024-01-20 09:00)',
        'Required',
        'Optional zone/area name',
        'Use exact driver names',
        'Optional map link or lat,lng',
        'Optional - defaults to Matter',
        'Optional - Villa or Apartment'
      ]
    ];

    const ws = XLSX.utils.aoa_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Delivery Template');

    ws['!cols'] = [
      { width: 14 },
      { width: 20 },
      { width: 26 },
      { width: 32 },
      { width: 18 },
      { width: 20 },
      { width: 36 },
      { width: 18 },
      { width: 16 }
    ];

    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let C = range.s.c; C <= range.e.c; C += 1) {
      const cellAddress = { c: C, r: 0 };
      const cellRef = XLSX.utils.encode_cell(cellAddress);
      if (!ws[cellRef]) continue;
      ws[cellRef].s = {
        font: { bold: true },
        fill: { fgColor: { rgb: 'D3D3D3' } }
      };
    }

    if (!ws['!merges']) ws['!merges'] = [];
    ws['!merges'].push({ s: { r: 4, c: 0 }, e: { r: 4, c: 7 } });

    XLSX.writeFile(wb, 'delivery_import_template.xlsx');
  };

  const clearImport = () => {
    setImportData([]);
    setValidationErrors([]);
    setFileName('');
    setImportProgress({
      total: 0,
      processed: 0,
      success: 0,
      error: 0,
      inProgress: false
    });
    const fileInput = document.getElementById('file-upload');
    if (fileInput) fileInput.value = '';
  };

  const showImportProgress = importProgress.inProgress || importProgress.total > 0;
  const progressPercent =
    importProgress.total > 0
      ? Math.min(100, Math.round((importProgress.processed / importProgress.total) * 100))
      : 0;
  const displayPercent =
    importProgress.total > 0 && importProgress.inProgress && progressPercent < 5 && importProgress.processed < importProgress.total
      ? 5
      : progressPercent;
  const inputCls = 'w-full bg-gray-50 border border-gray-200 rounded py-2 px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white transition-colors';
  const fieldLabelCls = 'block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5';

  return (
    <div className="matter-analytics p-3 sm:p-6 max-w-5xl mx-auto w-full">
      <div className="mb-4 sm:mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Add Delivery</h1>
          <p className="text-sm text-gray-500 mt-1 hidden sm:block">Create a new delivery record or schedule a collection.</p>
        </div>
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 px-3 py-2 text-gray-500 hover:text-gray-800 transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
          Cancel
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex border-b border-gray-200 bg-gray-50 overflow-x-auto no-scrollbar">
          <button
            onClick={() => handleTabChange('manual')}
            className={`flex-shrink-0 sm:flex-1 py-3 px-4 sm:py-4 sm:px-6 text-sm font-semibold whitespace-nowrap transition-colors ${
              activeTab === 'manual'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
            }`}
          >
            Single Delivery
          </button>
          <button
            onClick={() => handleTabChange('bulk')}
            className={`flex-shrink-0 sm:flex-1 py-3 px-4 sm:py-4 sm:px-6 text-sm font-semibold whitespace-nowrap transition-colors ${
              activeTab === 'bulk'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
            }`}
          >
            Bulk Entry
          </button>
          <button
            onClick={() => handleTabChange('task')}
            className={`flex-shrink-0 sm:flex-1 py-3 px-4 sm:py-4 sm:px-6 text-sm font-semibold whitespace-nowrap transition-colors ${
              activeTab === 'task'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
            }`}
          >
            Task
          </button>
          <button
            onClick={() => handleTabChange('collection')}
            className={`flex-shrink-0 sm:flex-1 py-3 px-4 sm:py-4 sm:px-6 text-sm font-semibold whitespace-nowrap transition-colors ${
              activeTab === 'collection'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
            }`}
          >
            Collection
          </button>
        </div>

      <div className="p-4 sm:p-8 pb-24 sm:pb-8">
      {activeTab === 'manual' ? (
        <motion.form
          id="manual-delivery-form"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onSubmit={handleSubmit}
          className="space-y-6"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
            <div className="md:col-span-2 pb-2 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Customer Details</h3>
            </div>

            <div>
              <label className={fieldLabelCls}>Customer ID *</label>
              <input
                type="text"
                name="customerId"
                value={formData.customerId}
                onChange={handleChange}
                required
                className={inputCls}
                placeholder="CUST001"
              />
            </div>

            <div>
              <label className={fieldLabelCls}>Customer Name *</label>
              <input
                type="text"
                name="customerName"
                value={formData.customerName}
                onChange={handleChange}
                required
                className={inputCls}
                placeholder="John Doe"
              />
            </div>

            <div className="md:col-span-2 pb-2 border-b border-gray-100 mt-2">
              <h3 className="text-lg font-semibold text-gray-900">Logistics</h3>
            </div>

            <ScheduledTimeField
              value={formData.scheduledTime}
              onChange={handleChange}
              label="Scheduled Time * (Local Time)"
              hint="Enter time in your local timezone"
            />

            <div>
              <label className={fieldLabelCls}>Delivery Zone</label>
              <input
                type="text"
                name="zone"
                value={formData.zone}
                onChange={handleChange}
                className={inputCls}
                placeholder="e.g., Dubai Marina"
              />
            </div>

            <div>
              <label className={fieldLabelCls}>GPS Location (Google Maps Link Recommended)</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[18px]">location_on</span>
                <input
                  type="text"
                  name="gpsLocation.link"
                  value={formData.gpsLocation.link}
                  onChange={handleNestedChange}
                  className={`${inputCls} pl-10`}
                  placeholder="https://maps.google.com/?q=40.7128,-74.0060"
                  onBlur={e => {
                    const link = e.target.value;
                    if (link) {
                      const coords = enhancedParseGPSFromLink(link);
                      if (coords) {
                        setFormData(prev => ({
                          ...prev,
                          gpsLocation: {
                            ...prev.gpsLocation,
                            lat: coords.lat,
                            lng: coords.lng,
                            link
                          }
                        }));
                      }
                    }
                  }}
                />
              </div>
            </div>

            <div>
              <label className={fieldLabelCls}>Assign Driver (optional)</label>
              <select
                name="driver"
                value={formData.driver}
                onChange={handleChange}
                className={`${inputCls} appearance-none`}
              >
                <option value="">Unassigned</option>
                {drivers.map(driver => (
                  <option key={driver._id} value={driver._id}>
                    {driver.profile.firstName} {driver.profile.lastName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={fieldLabelCls}>Company *</label>
              <div className="flex flex-wrap gap-2">
                {['Matter', 'Yellow Block', 'CookIt', 'Other'].map(company => (
                  <label
                    key={company}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border cursor-pointer transition-colors ${
                      formData.company === company
                        ? 'border-blue-600 bg-blue-50 text-blue-600'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="company"
                      value={company}
                      checked={formData.company === company}
                      onChange={handleChange}
                      className="sr-only"
                    />
                    {company}
                  </label>
                ))}
              </div>
              {formData.company === 'Other' && (
                <input
                  type="text"
                  name="otherCompany"
                  value={formData.otherCompany}
                  onChange={handleChange}
                  placeholder="Specify company name"
                  className={`${inputCls} mt-2`}
                />
              )}
            </div>

            <div className="md:col-span-2">
              <label className={fieldLabelCls}>Address *</label>
              <textarea
                name="address"
                value={formData.address}
                onChange={handleChange}
                rows={3}
                required
                className={`${inputCls} resize-none`}
                placeholder="123 Main Street, City, State, ZIP Code"
              />
            </div>

            <div className="md:col-span-2">
              <label className={fieldLabelCls}>Delivery Notes / Instructions</label>
              <textarea
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                rows={2}
                className={`${inputCls} resize-none`}
                placeholder="e.g. Leave at back door, gate code 1234"
              />
            </div>
          </div>

          <div className="hidden sm:flex justify-end gap-3 pt-6 border-t border-gray-100 mt-8">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-6 py-2 rounded border border-gray-200 bg-white text-gray-900 text-sm font-semibold hover:bg-gray-50 transition-colors"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 px-6 py-2 rounded bg-blue-600 text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {isSubmitting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  Creating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[18px]">save</span>
                  Save Delivery
                </>
              )}
            </button>
          </div>
        </motion.form>
      ) : activeTab === 'bulk' ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="space-y-6"
        >
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Import from Excel File
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              Upload an Excel file (.xlsx, .xls) with delivery data. Download the template below for
              the correct format.
            </p>

            <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-blue-900">Required Columns:</h4>
                  <p className="text-sm text-blue-700 mt-1">
                    Customer ID, Name, Delivery Time and Date, Location, Area, Driver, GPS, Company
                  </p>
                  <p className="text-sm text-blue-700 mt-1">
                    Optional: add a "Location Type" column (Villa or Apartment) to set it per row.
                  </p>
                </div>
                <button
                  onClick={downloadTemplate}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:opacity-90 transition-opacity flex-shrink-0"
                >
                  <span className="material-symbols-outlined text-[18px]">download</span>
                  Download Template
                </button>
              </div>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <label htmlFor="bulk-location-type" className="text-sm font-semibold text-gray-900">
                  Location Type
                </label>
                <p className="text-xs text-gray-500 mt-0.5">
                  Applied to every row in this file. Add a "Location Type" column in the sheet to set it per row instead.
                </p>
              </div>
              <select
                id="bulk-location-type"
                value={bulkLocationType}
                onChange={e => setBulkLocationType(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Not set</option>
                <option value="Villa">Villa</option>
                <option value="Apartment">Apartment</option>
              </select>
            </div>
          </div>

          <div className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center bg-gray-50">
            <input
              type="file"
              id="file-upload"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />

            {!fileName ? (
              <label htmlFor="file-upload" className="cursor-pointer">
                <div className="flex flex-col items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-4">
                    <span className="material-symbols-outlined text-blue-600 text-[32px]">upload_file</span>
                  </div>
                  <p className="text-lg font-semibold text-gray-900 mb-2">Upload Excel File</p>
                  <p className="text-sm text-gray-500 mb-4">
                    Drag and drop your file here or click to browse
                  </p>
                  <span className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:opacity-90 transition-opacity">
                    Choose File
                  </span>
                  <p className="text-xs text-gray-400 mt-2">
                    Supports .xlsx, .xls, .csv files
                  </p>
                </div>
              </label>
            ) : (
              <div className="flex flex-col items-center justify-center">
                <span className="material-symbols-outlined text-emerald-500 text-[48px] mb-4">description</span>
                <p className="text-lg font-semibold text-gray-900 mb-2">{fileName}</p>
                <p className="text-sm text-gray-500 mb-4">File uploaded successfully</p>
                <button onClick={clearImport} className="text-blue-600 hover:underline text-sm font-medium">
                  Upload different file
                </button>
              </div>
            )}
          </div>

          {showImportProgress && (
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between text-sm font-medium text-gray-700">
                <span>{importProgress.inProgress ? 'Importing deliveries...' : 'Import summary'}</span>
                <span>
                  {Math.min(importProgress.processed, importProgress.total)}/{importProgress.total}{' '}
                  processed
                </span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-3 mt-3">
                <div
                  className={`h-3 rounded-full transition-all duration-300 ${
                    importProgress.inProgress ? 'bg-blue-600' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${displayPercent}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs mt-3">
                <span className="text-emerald-600 font-semibold">
                  Success: {importProgress.success}
                </span>
                <span className="text-red-600 font-semibold">Failed: {importProgress.error}</span>
              </div>
            </div>
          )}

          {validationErrors.length > 0 && (
            <div className="bg-red-50 border border-red-100 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-red-500 text-[20px]">error</span>
                <h4 className="text-sm font-semibold text-red-800">
                  Validation Errors ({validationErrors.length})
                </h4>
              </div>
              <ul className="text-sm text-red-700 space-y-1 max-h-32 overflow-y-auto">
                {validationErrors.map((error, index) => (
                  <li key={index}>• {error}</li>
                ))}
              </ul>
            </div>
          )}

          {importData.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-lg font-semibold text-gray-900">Import Preview</h4>
                <div className="flex items-center gap-2 text-emerald-600 text-sm font-medium">
                  <span className="material-symbols-outlined text-[20px]">check_circle</span>
                  <span>{importData.length} valid deliveries ready to import</span>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Customer
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Scheduled
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Location
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Location Type
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Area
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Driver
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Company
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {importData.slice(0, 10).map(row => (
                        <tr key={row._id}>
                          <td className="px-4 py-3 text-sm">
                            <div className="font-medium text-gray-900">{row.customerName}</div>
                            <div className="text-gray-500">{row.customerId}</div>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {new Date(row.scheduledTime).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">{row.address}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {row.locationType || bulkLocationType || (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">{row.zone || '—'}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">{row.driverName || '—'}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">{row.company}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {importData.length > 10 && (
                  <div className="px-4 py-2 bg-gray-50 text-sm text-gray-500 text-center">
                    ... and {importData.length - 10} more deliveries
                  </div>
                )}
              </div>
            </div>
          )}

          {(fileName || importData.length > 0) && (
            <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
              <button
                onClick={clearImport}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                Clear
              </button>
              <button
                onClick={handleImportSubmit}
                disabled={isSubmitting || importData.length === 0 || validationErrors.length > 0}
                className="flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white rounded text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                {isSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                    Importing...
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[18px]">upload_file</span>
                    Import {importData.length} Deliveries
                  </>
                )}
              </button>
            </div>
          )}
        </motion.div>
      ) : activeTab === 'collection' ? (
        // Collection Tab
        <motion.form
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onSubmit={handleSubmit}
          className="space-y-6"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

            {/* Customer Search */}
            <div className="md:col-span-2 relative">
              <label className={fieldLabelCls}>Customer *</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px] pointer-events-none">search</span>
                <input
                  type="text"
                  value={customerSearch}
                  onChange={e => {
                    setCustomerSearch(e.target.value);
                    searchCustomers(e.target.value);
                  }}
                  onFocus={() => customerSearch.length >= 2 && setShowCustomerDropdown(customerResults.length > 0)}
                  onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 150)}
                  required={!formData.customerId}
                  className={`${inputCls} pl-10`}
                  placeholder="Type customer name or ID to search..."
                />
                {customerSearchLoading && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
                )}
              </div>
              {showCustomerDropdown && customerResults.length > 0 && (
                <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                  {customerResults.map(c => (
                    <button
                      key={c._id || c.customerId}
                      type="button"
                      onMouseDown={() => selectCustomer(c)}
                      className="w-full text-left px-4 py-2 hover:bg-teal-50 flex items-center gap-3"
                    >
                      <span className="font-medium text-gray-900">{c.firstName} {c.lastName}</span>
                      <span className="text-xs text-gray-400">{c.customerId}</span>
                    </button>
                  ))}
                </div>
              )}
              {formData.customerId && (
                <p className="text-xs text-teal-600 mt-1">Selected: {formData.customerName} ({formData.customerId})</p>
              )}
            </div>

            <ScheduledTimeField
              value={formData.scheduledTime}
              onChange={handleChange}
              label="Scheduled Date & Time *"
              hint="Enter time in your local timezone"
            />

            <div>
              <label className={fieldLabelCls}>Assign Driver (optional)</label>
              <select
                name="driver"
                value={formData.driver}
                onChange={handleChange}
                className={`${inputCls} appearance-none`}
              >
                <option value="">Unassigned</option>
                {drivers.map(driver => (
                  <option key={driver._id} value={driver._id}>
                    {driver.profile?.firstName} {driver.profile?.lastName} ({driver.email})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={fieldLabelCls}>Company *</label>
              <select
                name="company"
                value={formData.company}
                onChange={handleChange}
                required
                className={`${inputCls} appearance-none`}
              >
                <option value="Matter">Matter</option>
                <option value="Yellow Block">Yellow Block</option>
                <option value="CookIt">CookIt</option>
                <option value="Other">Other</option>
              </select>
            </div>

            {formData.company === 'Other' && (
              <div>
                <label className={fieldLabelCls}>Other Company Name *</label>
                <input
                  type="text"
                  name="otherCompany"
                  value={formData.otherCompany}
                  onChange={handleChange}
                  required
                  className={inputCls}
                  placeholder="Enter company name"
                />
              </div>
            )}

            {/* Bag Numbers */}
            <div className="md:col-span-2">
              <label className={fieldLabelCls}>Bag Numbers to Collect</label>
              <div className="space-y-2">
                {collectionBagIds.map((bagId, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={bagId}
                      onChange={e => updateBagId(index, e.target.value)}
                      placeholder={`Bag ID ${index + 1}`}
                      className={`flex-1 ${inputCls}`}
                    />
                    {collectionBagIds.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeBagIdField(index)}
                        className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg"
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addBagIdField}
                  className="flex items-center gap-2 px-3 py-2 text-teal-600 border border-teal-200 rounded hover:bg-teal-50 text-sm font-medium transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  Add another bag
                </button>
              </div>
            </div>

            <div className="md:col-span-2">
              <label className={fieldLabelCls}>Notes</label>
              <textarea
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                rows={2}
                className={`${inputCls} resize-none`}
                placeholder="Special instructions for collection..."
              />
            </div>

            {/* Location — auto-filled from customer's last delivery, editable */}
            <div className="md:col-span-2 border-t border-gray-100 pt-4">
              <p className="text-sm font-semibold text-gray-700 mb-3">
                Location <span className="font-normal text-gray-400">(auto-filled from customer's last delivery)</span>
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Address</label>
                  <textarea
                    name="address"
                    value={formData.address}
                    onChange={handleChange}
                    rows={2}
                    className={`${inputCls} text-sm resize-none`}
                    placeholder="Will be filled automatically after selecting a customer"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Zone / Area</label>
                  <input
                    type="text"
                    name="zone"
                    value={formData.zone}
                    onChange={handleChange}
                    className={`${inputCls} text-sm`}
                    placeholder="e.g., Dubai Marina"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">GPS Link</label>
                  <input
                    type="text"
                    name="gpsLocation.link"
                    value={formData.gpsLocation?.link || ''}
                    onChange={e =>
                      setFormData(prev => ({
                        ...prev,
                        gpsLocation: {
                          ...prev.gpsLocation,
                          link: e.target.value,
                          ...enhancedParseGPSFromLink(e.target.value)
                        }
                      }))
                    }
                    className={`${inputCls} text-sm`}
                    placeholder="Google Maps link"
                  />
                </div>
                {formData.gpsLocation?.lat && formData.gpsLocation?.lng && (
                  <div className="md:col-span-2">
                    <p className="text-xs text-teal-600 flex items-center gap-1">
                      <span className="material-symbols-outlined text-[14px]">location_on</span>
                      GPS: {Number(formData.gpsLocation.lat).toFixed(6)}, {Number(formData.gpsLocation.lng).toFixed(6)}
                      {formData.gpsLocation.link && (
                        <a href={formData.gpsLocation.link} target="_blank" rel="noopener noreferrer" className="ml-2 underline">View on map</a>
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-6 border-t border-gray-100">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-6 py-2 rounded border border-gray-200 bg-white text-gray-900 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 transition-colors"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !formData.customerId}
              className="flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {isSubmitting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  Creating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[18px]">save</span>
                  Create Collection
                </>
              )}
            </button>
          </div>
        </motion.form>
      ) : (
        // Task Tab
        <motion.form
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onSubmit={handleSubmit}
          className="space-y-6"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
            <div>
              <label className={fieldLabelCls}>Task Type *</label>
              <select
                name="taskType"
                value={formData.taskType}
                onChange={handleChange}
                className={`${inputCls} appearance-none`}
                required
              >
                <option value="Purchase">Purchase</option>
                <option value="Bag Collection">Bag Collection</option>
              </select>
            </div>

            <div>
              <label className={fieldLabelCls}>Customer ID *</label>
              <input
                type="text"
                name="customerId"
                value={formData.customerId}
                onChange={handleChange}
                required
                className={inputCls}
                placeholder="Enter customer ID"
              />
            </div>

            <div>
              <label className={fieldLabelCls}>Customer Name *</label>
              <input
                type="text"
                name="customerName"
                value={formData.customerName}
                onChange={handleChange}
                required
                className={inputCls}
                placeholder="Enter customer name"
              />
            </div>

            <ScheduledTimeField
              value={formData.scheduledTime}
              onChange={handleChange}
              label="Scheduled Time *"
            />

            <div>
              <label className={fieldLabelCls}>Assign Driver</label>
              <select
                name="driver"
                value={formData.driver}
                onChange={handleChange}
                className={`${inputCls} appearance-none`}
              >
                <option value="">Unassigned</option>
                {drivers.map(driver => (
                  <option key={driver._id} value={driver._id}>
                    {driver.profile?.firstName} {driver.profile?.lastName} ({driver.email})
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className={fieldLabelCls}>Location / Address *</label>
              <textarea
                name="address"
                value={formData.address}
                onChange={handleChange}
                rows={2}
                required
                className={`${inputCls} resize-none`}
                placeholder="Enter location or address"
              />
            </div>

            <div>
              <label className={fieldLabelCls}>Company *</label>
              <select
                name="company"
                value={formData.company}
                onChange={handleChange}
                required
                className={`${inputCls} appearance-none`}
              >
                <option value="Matter">Matter</option>
                <option value="Yellow Block">Yellow Block</option>
                <option value="CookIt">CookIt</option>
                <option value="Other">Other</option>
              </select>
            </div>

            {formData.company === 'Other' && (
              <div>
                <label className={fieldLabelCls}>Other Company Name *</label>
                <input
                  type="text"
                  name="otherCompany"
                  value={formData.otherCompany}
                  onChange={handleChange}
                  required
                  className={inputCls}
                  placeholder="Enter company name"
                />
              </div>
            )}

            <div>
              <label className={fieldLabelCls}>Area</label>
              <input
                type="text"
                name="zone"
                value={formData.zone}
                onChange={handleChange}
                className={inputCls}
                placeholder="e.g., Dubai Marina"
              />
            </div>

            <div>
              <label className={fieldLabelCls}>GPS Link</label>
              <input
                type="text"
                name="gpsLocation.link"
                value={formData.gpsLocation?.link || ''}
                onChange={e =>
                  setFormData(prev => ({
                    ...prev,
                    gpsLocation: {
                      ...prev.gpsLocation,
                      link: e.target.value,
                      ...enhancedParseGPSFromLink(e.target.value)
                    }
                  }))
                }
                className={inputCls}
                placeholder="Paste Google Maps or Apple Maps link"
              />
            </div>

            <div className="md:col-span-2">
              <label className={fieldLabelCls}>To-Do List</label>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={todoInput}
                    onChange={(e) => setTodoInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addTodoItem())}
                    className={`flex-1 ${inputCls}`}
                    placeholder="Add a task item"
                  />
                  <button
                    type="button"
                    onClick={addTodoItem}
                    className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:opacity-90 transition-opacity"
                  >
                    Add
                  </button>
                </div>
                {formData.todoList.length > 0 && (
                  <div className="space-y-2 mt-3">
                    {formData.todoList.map((item, index) => (
                      <div key={index} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-100">
                        <span className="flex-1 text-sm text-gray-700">{item.text}</span>
                        <button
                          type="button"
                          onClick={() => removeTodoItem(index)}
                          className="text-red-500 hover:text-red-700"
                        >
                          <span className="material-symbols-outlined text-[18px]">close</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="requireProof"
                  checked={formData.requireProof}
                  onChange={(e) => setFormData(prev => ({ ...prev, requireProof: e.target.checked }))}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                />
                <span className="text-sm font-medium text-gray-700">Require Picture Proof</span>
              </label>
            </div>

            <div className="md:col-span-2">
              <label className={fieldLabelCls}>Notes</label>
              <textarea
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                rows={3}
                className={`${inputCls} resize-none`}
                placeholder="Additional notes or instructions..."
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-6 border-t border-gray-100">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-6 py-2 rounded border border-gray-200 bg-white text-gray-900 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 transition-colors"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {isSubmitting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  Creating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[18px]">save</span>
                  Create Task
                </>
              )}
            </button>
          </div>
        </motion.form>
      )}
      </div>
      </div>

      {/* Mobile fixed bottom action bar (Single Delivery tab only) */}
      {activeTab === 'manual' && (
        <div className="sm:hidden fixed bottom-0 left-0 w-full bg-white border-t border-gray-200 p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.05)] z-20">
          <button
            type="submit"
            form="manual-delivery-form"
            disabled={isSubmitting}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white text-base font-semibold py-3 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {isSubmitting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                Creating...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-[18px]">save</span>
                Save Delivery
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default AddDelivery;

