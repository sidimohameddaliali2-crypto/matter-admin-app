import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion } from 'framer-motion';
import { Calendar, Download, Filter, BarChart3, Package, DollarSign } from 'lucide-react';
import * as XLSX from 'xlsx';
import { fetchReportData } from '../store/slices/reportSlice';
import api from '../utils/api';

const formatDateKeyLocal = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDateInput = (value) => {
  if (!value || typeof value !== 'string') return new Date();
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return new Date(value);
  return new Date(year, month - 1, day);
};

const MACRO_PLAN_MAP = [
  { C: 70,  P: 60,  F: 31,  plan: 'Lean 2 Meal' },
  { C: 115, P: 90,  F: 42,  plan: 'Lean 3 Meal' },
  { C: 130, P: 80,  F: 40,  plan: 'Thrive 2 Meal' },
  { C: 180, P: 120, F: 67,  plan: 'Thrive 3 Meal' },
  { C: 180, P: 100, F: 66,  plan: 'Perform 2 Meal' },
  { C: 225, P: 150, F: 100, plan: 'Perform 3 Meal' },
];
function getMealPlanFromMacros(C, P, F) {
  const c = Math.round(Number(C) || 0);
  const p = Math.round(Number(P) || 0);
  const f = Math.round(Number(F) || 0);
  if (!c && !p && !f) return null;
  const match = MACRO_PLAN_MAP.find(m => m.C === c && m.P === p && m.F === f);
  return match ? match.plan : 'Customized';
}

const Reports = () => {
  const dispatch = useDispatch();
  const { reportData, isLoading } = useSelector(state => state.report || {});
  
  // FIXED: Proper date initialization
  const [dateRange, setDateRange] = useState(() => {
    const end = new Date();
    end.setHours(23, 59, 59, 999); // End of day
    const start = new Date();
    start.setDate(start.getDate() - 30); // 30 days ago
    start.setHours(0, 0, 0, 0); // Start of day
    return { startDate: start, endDate: end };
  });

  // View mode state
  const [viewMode, setViewMode] = useState('summary'); // 'summary' or 'daily-list'
  const [selectedDate, setSelectedDate] = useState(formatDateKeyLocal(new Date()));
  const [selectedDriver, setSelectedDriver] = useState('all');
  const [selectedArea, setSelectedArea] = useState('all');
  const [selectedTime, setSelectedTime] = useState('all'); // 'morning', 'afternoon', 'evening', 'all'
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [excludedArea, setExcludedArea] = useState('none');
  const [filteredDeliveries, setFilteredDeliveries] = useState([]);
  const [dailyDateRange, setDailyDateRange] = useState(null);
  const logoDataUrlRef = useRef(null);

  // Monthly Sales Report state
  const [monthlyRange, setMonthlyRange] = useState(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {
      startDate: formatDateKeyLocal(start),
      endDate: formatDateKeyLocal(end),
    };
  });
  const [monthlyCustomers, setMonthlyCustomers] = useState([]);
  const [monthlyDeliveryCount, setMonthlyDeliveryCount] = useState({});
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyGenerated, setMonthlyGenerated] = useState(false);

  // Multi-Month Excel Export state (one worksheet per day)
  const [multiExportRange, setMultiExportRange] = useState(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1); // 3 months back, incl. current
    return {
      startDate: formatDateKeyLocal(start),
      endDate: formatDateKeyLocal(now),
    };
  });
  const [multiExportLoading, setMultiExportLoading] = useState(false);

  const normalizeStatus = (delivery) => {
    const rawStatus = (delivery.status || '').toString().trim().toLowerCase();
    const isDriverMissing = !delivery.driverName && !delivery.driver?.profile?.name;

    if (!rawStatus && isDriverMissing) return 'unassigned';
    if (rawStatus.includes('unassign')) return 'unassigned';
    if (rawStatus === 'cancelled' || rawStatus === 'canceled') return 'cancelled';
    if (rawStatus === 'delivered' || rawStatus === 'completed' || rawStatus === 'done') return 'delivered';
    if (
      rawStatus === 'assigned' ||
      rawStatus === 'schedule' ||
      rawStatus === 'scheduled'
    ) return 'assigned';
    if (
      rawStatus === 'pending' ||
      rawStatus === 'in progress' ||
      rawStatus === 'in-progress' ||
      rawStatus === 'inprogress' ||
      rawStatus === 'out for delivery' ||
      rawStatus === 'out-for-delivery' ||
      rawStatus === 'out_for_delivery' ||
      rawStatus === 'in transit' ||
      rawStatus === 'in-transit'
    ) return 'pending';
    return rawStatus || 'pending';
  };

  const normalizeArea = (value) => (value || '').toString().trim().toLowerCase();

  const areaOptions = useMemo(() => {
    const map = new Map();

    // Seed with backend-provided areas
    (reportData?.areas || []).forEach((area) => {
      const norm = normalizeArea(area);
      if (norm && !map.has(norm)) map.set(norm, area);
    });

    // Derive from deliveries as fallback (area, assignedTo.area, zone)
    (reportData?.allDeliveries || []).forEach((delivery) => {
      const candidates = [delivery.area, delivery.assignedTo?.area, delivery.zone];
      candidates.forEach((raw) => {
        const norm = normalizeArea(raw);
        if (norm && !map.has(norm)) map.set(norm, raw);
      });
    });

    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }, [reportData]);

  useEffect(() => {
    // When viewing daily list, fetch data for just that day
    if (viewMode === 'daily-list') {
      const selectedDateObj = parseDateInput(selectedDate);
      const start = new Date(selectedDateObj);
      start.setHours(0, 0, 0, 0);
      const end = new Date(selectedDateObj);
      end.setHours(23, 59, 59, 999);
      setDailyDateRange({ startDate: start, endDate: end });
      console.log('📅 Fetching daily data for:', selectedDate);
      dispatch(fetchReportData({ startDate: start, endDate: end }));
    } else {
      // For summary view, use the date range selector
      console.log('🔄 Fetching report data for:', dateRange);
      dispatch(fetchReportData(dateRange));
    }
  }, [dispatch, viewMode, selectedDate, dateRange.startDate, dateRange.endDate]);

  // Filter deliveries based on selected criteria
  useEffect(() => {
    if (viewMode === 'daily-list' && reportData?.allDeliveries) {
      console.log('📊 Filtering deliveries:', {
        selectedDate,
        totalDeliveries: reportData.allDeliveries.length,
        availableDrivers: reportData.drivers,
        availableAreas: reportData.areas
      });

      let filtered = reportData.allDeliveries.filter(delivery => {
        const deliveryDate = formatDateKeyLocal(new Date(delivery.scheduledTime));
        
        // Date filter
        if (deliveryDate !== selectedDate) return false;
        
        // Driver filter (supports Unassigned and case-insensitive match)
        const driverNameRaw = delivery.driverName || delivery.driver?.profile?.name || '';
        const driverNameTrim = driverNameRaw.trim();
        const driverNameNorm = driverNameTrim.toLowerCase();
        const selectedDriverNorm = selectedDriver.toLowerCase();

        if (selectedDriver === 'unassigned') {
          const isUnassigned = !driverNameTrim || driverNameNorm === 'unassigned' || driverNameNorm === 'none';
          if (!isUnassigned) return false;
        } else if (selectedDriver !== 'all' && driverNameNorm !== selectedDriverNorm) {
          return false;
        }
        
        // Area filter (case-insensitive)
        const areaCandidates = [delivery.area, delivery.assignedTo?.area, delivery.zone];
        const selectedAreaNorm = normalizeArea(selectedArea);
        if (selectedArea !== 'all') {
          const matched = areaCandidates.some((candidate) => normalizeArea(candidate) === selectedAreaNorm);
          if (!matched) return false;
        }
        if (excludedArea !== 'none') {
          const isExcluded = areaCandidates.some((candidate) => normalizeArea(candidate) === normalizeArea(excludedArea));
          if (isExcluded) return false;
        }
        
        // Status filter (includes Unassigned & Assigned)
        const status = normalizeStatus(delivery);
        if (selectedStatus !== 'all') {
          if (selectedStatus === 'pending') {
            if (status !== 'pending' && status !== 'assigned') return false; // treat assigned as pending-equivalent
          } else if (status !== selectedStatus) {
            return false;
          }
        }

        // Time filter
        if (selectedTime !== 'all') {
          const hour = new Date(delivery.scheduledTime).getHours();
          switch (selectedTime) {
            case 'morning':
              if (hour < 6 || hour >= 12) return false;
              break;
            case 'afternoon':
              if (hour < 12 || hour >= 18) return false;
              break;
            case 'evening':
              if (hour < 18 || hour >= 24) return false;
              break;
          }
        }
        
        return true;
      });
      
      console.log('✅ Filtered deliveries:', filtered.length);
      setFilteredDeliveries(filtered);
    }
  }, [viewMode, selectedDate, selectedDriver, selectedArea, excludedArea, selectedTime, selectedStatus, reportData]);

  const generateMonthlySalesReport = async () => {
    setMonthlyLoading(true);
    setMonthlyGenerated(false);
    try {
      // monthlyRange holds "YYYY-MM-DD" keys — the report API reads them as
      // Dubai business dates (whole end day included).
      const [custRes, reportRes] = await Promise.all([
        api.get('/customers', { params: { limit: 2000 } }),
        api.get('/reports', {
          params: {
            startDate: monthlyRange.startDate,
            endDate: monthlyRange.endDate,
          }
        }),
      ]);

      const customers = Array.isArray(custRes.data?.data) ? custRes.data.data : [];
      const deliveries = reportRes.data?.data?.allDeliveries || [];

      // Group deliveries by customerId — skip cancelled deliveries
      const countMap = {};
      deliveries.forEach(d => {
        if (d.status === 'cancelled') return;
        const id = d.customerId || d.customerID;
        if (id) countMap[id] = (countMap[id] || 0) + 1;
      });

      setMonthlyCustomers(customers);
      setMonthlyDeliveryCount(countMap);
      setMonthlyGenerated(true);
    } catch (err) {
      console.error('Monthly sales fetch error:', err);
    } finally {
      setMonthlyLoading(false);
    }
  };

  // Handle date range changes
  const handleDateChange = (field, value) => {
    const newDate = parseDateInput(value);
    if (field === 'startDate') {
      newDate.setHours(0, 0, 0, 0); // Start of day
    } else {
      newDate.setHours(23, 59, 59, 999); // End of day
    }
    const newDateRange = {
      ...dateRange,
      [field]: newDate
    };
    setDateRange(newDateRange);
  };

  // Apply filter with new date range
  const handleApplyFilter = () => {
    console.log('🔍 Applying filter with:', dateRange);
    dispatch(fetchReportData(dateRange));
  };

  // Add this function inside your Reports component, before the return statement
const handleExport = async (format) => {
  try {
    console.log(`📤 Exporting ${format} report...`);
    
    if (format === 'csv') {
      // Generate CSV from current report data
      const csvData = generateCSV(reportData);
      downloadFile(csvData, 'delivery-report.csv', 'text/csv');
    } else if (format === 'pdf') {
      // For PDF, we'll create a simple HTML table and print it
      generatePDF(reportData);
    }
    
  } catch (error) {
    console.error('Export error:', error);
    alert(`Failed to export ${format} report`);
  }
};

// CSV Generator
const generateCSV = (data) => {
  if (!data) return '';
  
  let csv = 'Delivery Report\n\n';
  
  // Summary section
  csv += 'SUMMARY\n';
  csv += 'Total Deliveries,' + (data.summary?.totalDeliveries || 0) + '\n';
  csv += 'Completed Deliveries,' + (data.summary?.deliveredCount || 0) + '\n';
  csv += 'Late Deliveries,' + (data.summary?.lateDeliveries || 0) + '\n';
  csv += 'Early Deliveries,' + (data.summary?.earlyDeliveries || 0) + '\n';
  csv += 'Accuracy Rate,' + (data.summary?.accuracyRate || 0) + '%\n\n';
  
  // Deliveries by Driver
  if (data.deliveriesByDriver?.length > 0) {
    csv += 'DELIVERIES BY DRIVER\n';
    csv += 'Driver,Count\n';
    data.deliveriesByDriver.forEach(item => {
      csv += `"${item.driver || 'Unknown'}",${item.count || 0}\n`;
    });
    csv += '\n';
  }
  
  // Deliveries by Company
  if (data.deliveriesByCompany?.length > 0) {
    csv += 'DELIVERIES BY COMPANY\n';
    csv += 'Company,Count\n';
    data.deliveriesByCompany.forEach(item => {
      csv += `"${item.company || 'Unknown'}",${item.count || 0}\n`;
    });
  }
  
  return csv;
};

// File Download Helper
const downloadFile = (content, fileName, contentType) => {
  const blob = new Blob([content], { type: contentType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
};

// PDF Generator (Simple version using window.print)
const generatePDF = (data) => {
  // Create a printable version of the report
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>Delivery Report</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h1 { color: #333; }
          .section { margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f5f5f5; }
          .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 20px; }
          .summary-item { padding: 15px; border-radius: 5px; text-align: center; }
        </style>
      </head>
      <body>
        <h1>Delivery Report</h1>
        <p>Generated on: ${new Date().toLocaleDateString()}</p>
        
        <div class="section">
          <h2>Summary</h2>
          <div class="summary-grid">
            <div class="summary-item" style="background-color: #e3f2fd;">
              <h3>${data.summary?.totalDeliveries || 0}</h3>
              <p>Total Deliveries</p>
            </div>
            <div class="summary-item" style="background-color: #e8f5e8;">
              <h3>${data.summary?.deliveredCount || 0}</h3>
              <p>Completed</p>
            </div>
            <div class="summary-item" style="background-color: #fef3c7;">
              <h3>${data.summary?.earlyDeliveries || 0}</h3>
              <p>Early Deliveries</p>
            </div>
            <div class="summary-item" style="background-color: #ffebee;">
              <h3>${data.summary?.lateDeliveries || 0}</h3>
              <p>Late Deliveries</p>
            </div>
            <div class="summary-item" style="background-color: #f3e5f5;">
              <h3>${data.summary?.accuracyRate || 0}%</h3>
              <p>Accuracy Rate</p>
            </div>
          </div>
        </div>
        
        ${data.deliveriesByDriver?.length > 0 ? `
        <div class="section">
          <h2>Deliveries by Driver</h2>
          <table>
            <thead>
              <tr>
                <th>Driver</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              ${data.deliveriesByDriver.map(item => `
                <tr>
                  <td>${item.driver || 'Unknown'}</td>
                  <td>${item.count || 0}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ` : ''}
        
        ${data.deliveriesByCompany?.length > 0 ? `
        <div class="section">
          <h2>Deliveries by Company</h2>
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              ${data.deliveriesByCompany.map(item => `
                <tr>
                  <td>${item.company || 'Unknown'}</td>
                  <td>${item.count || 0}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ` : ''}
        
        <script>
          window.onload = function() {
            window.print();
            setTimeout(() => window.close(), 500);
          };
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
};

  const getLogoDataUrl = async () => {
    if (logoDataUrlRef.current) return logoDataUrlRef.current;
    try {
      const response = await fetch('/logo.svg');
      const svgText = await response.text();
      const base64 = window.btoa(unescape(encodeURIComponent(svgText)));
      const dataUrl = `data:image/svg+xml;base64,${base64}`;
      logoDataUrlRef.current = dataUrl;
      return dataUrl;
    } catch (error) {
      console.warn('Failed to load logo for export', error);
      return null;
    }
  };

  const exportDailyList = async (format) => {
    if (!filteredDeliveries.length) {
      alert('No deliveries to export for this day.');
      return;
    }

    // Meals/day and snacks/day live on the Customer record, not on Delivery
    // (the /reports endpoint this page's data comes from never populates
    // customer) — fetched once here, same endpoint/pattern already used by
    // generateMonthlySalesReport above, and looked up per row by customerId.
    let mealsByCustomerId = {};
    try {
      const { data } = await api.get('/customers', { params: { limit: 2000 } });
      const customers = Array.isArray(data?.data) ? data.data : [];
      mealsByCustomerId = customers.reduce((acc, c) => {
        if (c.customerId) acc[c.customerId] = { mealPerDay: c.mealPerDay, snackCount: c.snackCount };
        return acc;
      }, {});
    } catch (err) {
      console.warn('Failed to load customer meal/snack data for export', err);
    }
    const mealsFor = (delivery) => mealsByCustomerId[delivery.customerId || delivery.customerID] || {};

    if (format === 'excel') {
      const sheetData = [];
      sheetData.push(['Matter Delivery Tracker']);
      sheetData.push([`Daily deliveries for ${selectedDate}`]);
      sheetData.push([`Total deliveries: ${filteredDeliveries.length}`]);
      sheetData.push([]);
      sheetData.push(['Customer ID', 'Customer', 'Address', 'Driver', 'Area', 'Scheduled Time', 'Status', 'Timing', 'Meals/Day', 'Snacks/Day']);

      filteredDeliveries.forEach((delivery) => {
        const status = normalizeStatus(delivery);
        const driverName = delivery.driver?.profile?.name || delivery.driverName || 'Unassigned';
        const area = delivery.area || delivery.assignedTo?.area || '-';
        const date = new Date(delivery.scheduledTime);
        const offsetMinutes = Number(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || 0);
        const localDate = new Date(date.getTime() + offsetMinutes * 60 * 1000);
        const scheduledTime = `${String(localDate.getUTCHours()).padStart(2, '0')}:${String(localDate.getUTCMinutes()).padStart(2, '0')}`;
        const timing = delivery.lateMinutes > 0
          ? `${delivery.lateMinutes} min late`
          : delivery.earlyMinutes > 0
            ? `${delivery.earlyMinutes} min early`
            : 'On time';
        const meals = mealsFor(delivery);

        sheetData.push([
          delivery.customerId || delivery.customerID || '-',
          delivery.customerName || '-',
          delivery.address || '-',
          driverName,
          area,
          scheduledTime,
          status,
          timing,
          meals.mealPerDay ?? '-',
          meals.snackCount ?? '-',
        ]);
      });

      const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Daily Deliveries');
      const workbookArray = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      downloadFile(workbookArray, `daily-deliveries-${selectedDate}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return;
    }

    if (format === 'pdf') {
      const logoDataUrl = await getLogoDataUrl();
      const logoSrc = logoDataUrl || '/logo.svg';
      const printWindow = window.open('', '_blank');
      const rowsHtml = filteredDeliveries.map((delivery) => {
        const status = normalizeStatus(delivery);
        const driverName = delivery.driver?.profile?.name || delivery.driverName || 'Unassigned';
        const area = delivery.area || delivery.assignedTo?.area || delivery.zone || '-';
        const date = new Date(delivery.scheduledTime);
        const offsetMinutes = Number(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || 0);
        const localDate = new Date(date.getTime() + offsetMinutes * 60 * 1000);
        const scheduledTime = `${String(localDate.getUTCHours()).padStart(2, '0')}:${String(localDate.getUTCMinutes()).padStart(2, '0')}`;
        const timing = delivery.lateMinutes > 0
          ? `${delivery.lateMinutes} min late`
          : delivery.earlyMinutes > 0
            ? `${delivery.earlyMinutes} min early`
            : 'On time';
        const meals = mealsFor(delivery);

        return `
          <tr>
            <td>${delivery.customerName || '-'}</td>
            <td>${delivery.address || '-'}</td>
            <td>${driverName}</td>
            <td>${area}</td>
            <td>${scheduledTime}</td>
            <td>${status}</td>
            <td>${timing}</td>
            <td>${meals.mealPerDay ?? '-'}</td>
            <td>${meals.snackCount ?? '-'}</td>
          </tr>
        `;
      }).join('');

      printWindow.document.write(`
        <html>
          <head>
            <title>Daily Deliveries - ${selectedDate}</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 24px; }
              h1 { color: #1f2937; margin: 0; }
              .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
              .meta { color: #6b7280; margin-bottom: 20px; }
              table { width: 100%; border-collapse: collapse; }
              th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; font-size: 12px; }
              th { background: #f3f4f6; }
              .logo { height: 48px; }
            </style>
          </head>
          <body>
            <div class="header">
              <img src="${logoSrc}" alt="Logo" class="logo" />
              <div>
                <h1>Daily Deliveries</h1>
                <div class="meta">Date: ${selectedDate}</div>
                <div class="meta">Total deliveries: ${filteredDeliveries.length}</div>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Address</th>
                  <th>Driver</th>
                  <th>Area</th>
                  <th>Scheduled Time</th>
                  <th>Status</th>
                  <th>Timing</th>
                  <th>Meals/Day</th>
                  <th>Snacks/Day</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
            <script>
              window.onload = function() {
                window.print();
                setTimeout(() => window.close(), 500);
              };
            </script>
          </body>
        </html>
      `);
      printWindow.document.close();
    }
  };

  

  // Format date for display
  const generateMultiMonthExcel = async () => {
    setMultiExportLoading(true);
    try {
      const start = parseDateInput(multiExportRange.startDate);
      start.setHours(0, 0, 0, 0);
      const end = parseDateInput(multiExportRange.endDate);
      end.setHours(23, 59, 59, 999);

      if (start > end) {
        alert('Start date must be before end date.');
        return;
      }

      const response = await api.get('/reports', {
        params: { startDate: multiExportRange.startDate, endDate: multiExportRange.endDate }
      });
      const deliveries = response.data?.data?.allDeliveries || [];

      if (deliveries.length === 0) {
        alert('No deliveries found for the selected date range.');
        return;
      }

      const offsetMinutes = Number(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || 240);
      const formatTime = (d) => {
        const local = new Date(new Date(d).getTime() + offsetMinutes * 60 * 1000);
        return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
      };

      // One worksheet per Dubai business day — keyed with the same offset as
      // formatTime (not the browser's own timezone), so a 03:00 delivery lands
      // on its real day and matches the server's report grouping.
      const byDay = new Map();
      deliveries.forEach((delivery) => {
        if (!delivery.scheduledTime) return;
        const dayKey = new Date(new Date(delivery.scheduledTime).getTime() + offsetMinutes * 60 * 1000).toISOString().slice(0, 10);
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey).push(delivery);
      });

      const sortedDays = Array.from(byDay.keys()).sort();

      const workbook = XLSX.utils.book_new();
      sortedDays.forEach((dayKey) => {
        const dayDeliveries = byDay.get(dayKey)
          .slice()
          .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));

        const sheetData = [
          ['Matter Delivery Tracker'],
          [`Deliveries for ${dayKey}`],
          [`Total: ${dayDeliveries.length}`],
          [],
          ['Customer ID', 'Customer', 'Address', 'Zone', 'Scheduled Time', 'Delivered Time', 'Status', 'Driver'],
        ];

        dayDeliveries.forEach((delivery) => {
          const driverName = delivery.driverName || delivery.driver?.profile?.name || 'Unassigned';
          const deliveredTimeStr = delivery.deliveredTime ? formatTime(delivery.deliveredTime) : 'Not delivered';
          const zone = delivery.area || delivery.assignedTo?.area || delivery.zone || '-';

          let statusLabel;
          if (!delivery.deliveredTime) {
            statusLabel = 'Not delivered';
          } else if (delivery.lateMinutes > 0) {
            statusLabel = `Late (${delivery.lateMinutes} min)`;
          } else if (delivery.earlyMinutes > 0) {
            statusLabel = `Early (${delivery.earlyMinutes} min)`;
          } else {
            statusLabel = 'On time';
          }

          sheetData.push([
            delivery.customerId || delivery.customerID || '-',
            delivery.customerName || '-',
            delivery.address || '-',
            zone,
            formatTime(delivery.scheduledTime),
            deliveredTimeStr,
            statusLabel,
            driverName,
          ]);
        });

        const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
        worksheet['!cols'] = [16, 24, 32, 16, 14, 14, 16, 20].map((w) => ({ wch: w }));
        // Sheet names can't exceed 31 chars or contain : \ / ? * [ ] — "YYYY-MM-DD" is safe
        XLSX.utils.book_append_sheet(workbook, worksheet, dayKey);
      });

      const workbookArray = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      downloadFile(
        workbookArray,
        `deliveries-${multiExportRange.startDate}-to-${multiExportRange.endDate}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    } catch (error) {
      console.error('Multi-month export error:', error);
      alert('Failed to generate the Excel export. Please try again.');
    } finally {
      setMultiExportLoading(false);
    }
  };

  // Format date for display
  const formatDate = (date) => {
    return date.toLocaleDateString();
  };

  console.log('📊 Report Data:', reportData);
  console.log('⏳ Is Loading:', isLoading);
  console.log('📋 View Mode:', viewMode);

  // Show page even if loading, just show loading indicator
  // This prevents the page from being stuck on loading screen

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports & Analytics</h1>
          <p className="text-gray-500">Delivery performance and insights</p>
        </div>
        {isLoading && (
          <div className="text-sm text-orange-600 font-medium animate-pulse">
            ⏳ Loading data...
          </div>
        )}
      </div>

      {/* View Mode Toggle */}
      <div className="bg-white rounded-lg shadow-md border-2 border-blue-300 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Select Report Type</h3>
        <div className="flex flex-wrap gap-4">
          <button
            onClick={() => setViewMode('summary')}
            className={`px-6 py-3 rounded-lg font-semibold transition-all ${
              viewMode === 'summary'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
            }`}
          >
            📊 Summary Report
          </button>
          <button
            onClick={() => setViewMode('daily-list')}
            className={`px-6 py-3 rounded-lg font-semibold transition-all ${
              viewMode === 'daily-list'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
            }`}
          >
            📋 Daily Deliveries List
          </button>
          <button
            onClick={() => setViewMode('monthly-sales')}
            className={`px-6 py-3 rounded-lg font-semibold transition-all ${
              viewMode === 'monthly-sales'
                ? 'bg-emerald-600 text-white shadow-lg'
                : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
            }`}
          >
            📅 Monthly Sales Report
          </button>
          <button
            onClick={() => setViewMode('multi-month-export')}
            className={`px-6 py-3 rounded-lg font-semibold transition-all ${
              viewMode === 'multi-month-export'
                ? 'bg-indigo-600 text-white shadow-lg'
                : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
            }`}
          >
            🗂️ Multi-Month Excel Export
          </button>
        </div>
      </div>

      {/* Multi-Month Excel Export View */}
      {viewMode === 'multi-month-export' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Multi-Month Excel Export</h2>
          <p className="text-sm text-gray-500 mb-4">
            Download deliveries across a date range as a single Excel workbook — one worksheet per day,
            with customer, address, scheduled time, delivered time, on-time/late/early status, and assigned driver.
          </p>
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
              <input
                type="date"
                value={multiExportRange.startDate}
                onChange={(e) => setMultiExportRange((r) => ({ ...r, startDate: e.target.value }))}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
              <input
                type="date"
                value={multiExportRange.endDate}
                onChange={(e) => setMultiExportRange((r) => ({ ...r, endDate: e.target.value }))}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <button
              onClick={generateMultiMonthExcel}
              disabled={multiExportLoading}
              className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              <Download className="w-4 h-4" />
              {multiExportLoading ? 'Generating…' : 'Download Excel'}
            </button>
          </div>
          <p className="mt-3 text-xs text-gray-400">
            Large ranges can produce a workbook with many worksheets — only days with at least one delivery are included.
          </p>
        </div>
      )}

      {/* Monthly Sales Report View */}
      {viewMode === 'monthly-sales' && (() => {
        const rows = monthlyGenerated
          ? monthlyCustomers
              .filter(c => monthlyDeliveryCount[c.customerId])
              .map(c => {
                const daysUsed = monthlyDeliveryCount[c.customerId] || 0;
                const amountPaid = parseFloat(String(c.amountPaid || '0').replace(/,/g, '')) || 0;
                const cycleDuration = Number(c.cycleDuration) || 0;
                const dailyRate = cycleDuration > 0 ? amountPaid / cycleDuration : 0;
                const monthlyExpense = dailyRate * daysUsed;
                const derivedPlan = getMealPlanFromMacros(c.macros?.C, c.macros?.P, c.macros?.F)
                  || c.mealPlan || '—';
                return {
                  customerId: c.customerId,
                  customerName: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.customerId,
                  mealPlan: derivedPlan,
                  daysUsed,
                  cycleDuration,
                  amountPaid,
                  dailyRate,
                  monthlyExpense,
                };
              })
              .sort((a, b) => b.monthlyExpense - a.monthlyExpense)
          : [];

        const totalDaysUsed = rows.reduce((s, r) => s + r.daysUsed, 0);
        const totalExpense = rows.reduce((s, r) => s + r.monthlyExpense, 0);
        const rangeLabel = monthlyRange.startDate === monthlyRange.endDate
          ? monthlyRange.startDate
          : `${monthlyRange.startDate} → ${monthlyRange.endDate}`;

        const exportExcel = () => {
          if (!rows.length) { alert('No data to export.'); return; }
          const sheetData = [
            ['Monthly Expense Report'],
            [`Period: ${rangeLabel}`],
            [`Generated: ${new Date().toLocaleDateString()}`],
            [],
            ['#', 'Customer Name', 'Meal Plan', 'Days Used', 'Cycle Duration', 'Amount Paid (AED)', 'Daily Rate (AED)', 'Monthly Expense (AED)'],
          ];
          rows.forEach((r, i) => sheetData.push([
            i + 1, r.customerName, r.mealPlan, r.daysUsed,
            r.cycleDuration || '—',
            r.amountPaid ? r.amountPaid.toFixed(2) : '—',
            r.dailyRate ? r.dailyRate.toFixed(2) : '—',
            r.monthlyExpense.toFixed(2),
          ]));
          sheetData.push([]);
          sheetData.push(['', 'TOTAL', '', totalDaysUsed, '', '', '', totalExpense.toFixed(2)]);
          const ws = XLSX.utils.aoa_to_sheet(sheetData);
          ws['!cols'] = [5, 28, 16, 14, 16, 22, 18, 18].map(w => ({ wch: w }));
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'Monthly Expense');
          const arr = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
          downloadFile(arr, `monthly-expense-${monthlyRange.startDate}-${monthlyRange.endDate}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        };

        return (
          <>
            {/* Controls */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Monthly Expense Report</h2>
              <div className="flex flex-wrap gap-4 items-end">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
                  <input
                    type="date"
                    value={monthlyRange.startDate}
                    onChange={e => setMonthlyRange(r => ({ ...r, startDate: e.target.value }))}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
                  <input
                    type="date"
                    value={monthlyRange.endDate}
                    onChange={e => setMonthlyRange(r => ({ ...r, endDate: e.target.value }))}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <button
                  onClick={generateMonthlySalesReport}
                  disabled={monthlyLoading}
                  className="px-5 py-2 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 disabled:opacity-50 transition"
                >
                  {monthlyLoading ? 'Loading…' : 'Generate Report'}
                </button>
              </div>
            </div>

            {/* Table */}
            {(monthlyGenerated || monthlyLoading) && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {rangeLabel} — {rows.length} customers
                  </h2>
                  {rows.length > 0 && (
                    <button
                      onClick={exportExcel}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition"
                    >
                      <Download className="w-4 h-4" />
                      Download Excel
                    </button>
                  )}
                </div>

                {monthlyLoading ? (
                  <div className="text-center py-12 text-gray-400 animate-pulse">Loading…</div>
                ) : rows.length === 0 ? (
                  <div className="text-center py-12">
                    <Package className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                    <p className="text-gray-500">No deliveries found for this period</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">#</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Meal Plan</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Days Used</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Cycle</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Amount Paid</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Daily Rate</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-emerald-600 uppercase">Monthly Expense</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-100">
                        {rows.map((r, i) => (
                          <tr key={r.customerId} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-gray-400">{i + 1}</td>
                            <td className="px-4 py-3 font-medium text-gray-900">{r.customerName}</td>
                            <td className="px-4 py-3 text-gray-600">{r.mealPlan}</td>
                            <td className="px-4 py-3 text-center font-semibold text-blue-700">{r.daysUsed}</td>
                            <td className="px-4 py-3 text-center text-gray-500">{r.cycleDuration || '—'}</td>
                            <td className="px-4 py-3 text-center text-gray-700">
                              {r.amountPaid ? `AED ${r.amountPaid.toFixed(2)}` : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3 text-center text-gray-600">
                              {r.dailyRate ? `AED ${r.dailyRate.toFixed(2)}` : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {r.monthlyExpense > 0 ? (
                                <span className="px-3 py-1 bg-emerald-100 text-emerald-800 rounded-full font-bold">
                                  AED {r.monthlyExpense.toFixed(2)}
                                </span>
                              ) : (
                                <span className="text-gray-300 text-xs">No plan data</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                        <tr>
                          <td colSpan={3} className="px-4 py-3 font-bold text-gray-900">Total</td>
                          <td className="px-4 py-3 text-center font-bold text-blue-700">{totalDaysUsed}</td>
                          <td colSpan={3} />
                          <td className="px-4 py-3 text-center">
                            <span className="px-3 py-1 bg-emerald-600 text-white rounded-full font-bold">
                              AED {totalExpense.toFixed(2)}
                            </span>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        );
      })()}

      {/* Daily List View */}
      {viewMode === 'daily-list' && (
        <>
          {/* Filters for Daily View */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Daily Deliveries Filters</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              {/* Date Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Date
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {/* Driver Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Driver
                </label>
                <select
                  value={selectedDriver}
                  onChange={(e) => setSelectedDriver(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">All Drivers</option>
                  <option value="unassigned">Unassigned</option>
                  {reportData?.drivers?.map(driver => (
                    <option key={driver} value={driver}>
                      {driver}
                    </option>
                  ))}
                </select>
              </div>

              {/* Status Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Status
                </label>
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">All Statuses</option>
                  <option value="assigned">Assigned</option>
                  <option value="delivered">Delivered</option>
                  <option value="pending">Pending</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="unassigned">Unassigned</option>
                </select>
              </div>

              {/* Area Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Area
                </label>
                <select
                  value={selectedArea}
                  onChange={(e) => setSelectedArea(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">All Areas</option>
                  {areaOptions.map(area => (
                    <option key={area} value={area}>
                      {area}
                    </option>
                  ))}
                </select>
              </div>

              {/* Exclude Area Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Exclude Area
                </label>
                <select
                  value={excludedArea}
                  onChange={(e) => setExcludedArea(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="none">Do not exclude</option>
                  {areaOptions.map(area => (
                    <option key={area} value={area}>
                      {area}
                    </option>
                  ))}
                </select>
              </div>

              {/* Time Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Time Window
                </label>
                <select
                  value={selectedTime}
                  onChange={(e) => setSelectedTime(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">All Times</option>
                  <option value="morning">Morning (6 AM - 12 PM)</option>
                  <option value="afternoon">Afternoon (12 PM - 6 PM)</option>
                  <option value="evening">Evening (6 PM - 12 AM)</option>
                </select>
              </div>
            </div>
            <div className="mt-4 text-sm text-gray-600">
              Showing {filteredDeliveries.length} deliveries for {selectedDate}
              {reportData?.allDeliveries?.length > 0 && (
                <span className="ml-2 text-blue-600">
                  (Total available: {reportData.allDeliveries.length})
                </span>
              )}
            </div>
          </div>

          {/* Daily Deliveries List */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Deliveries</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => exportDailyList('excel')}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 transition"
                >
                  <Download className="w-4 h-4" />
                  Download Excel
                </button>
                <button
                  onClick={() => exportDailyList('pdf')}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition"
                >
                  <Download className="w-4 h-4" />
                  Download PDF
                </button>
              </div>
            </div>
            {filteredDeliveries.length === 0 ? (
              <div className="text-center py-12">
                <Package className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                <h3 className="text-lg font-semibold text-gray-900">No Deliveries Found</h3>
                <p className="text-gray-500 mt-2">
                  No deliveries match the selected filters for {selectedDate}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Customer
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Address
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Driver
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Area
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Scheduled Time
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Timing
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredDeliveries.map((delivery, index) => {
                      const normalizedStatus = normalizeStatus(delivery);
                      const statusLabel = normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1);
                      const driverName = delivery.driver?.profile?.name || delivery.driverName || 'Unassigned';
                      const area = delivery.area || delivery.assignedTo?.area || delivery.zone || '-';
                      
                      return (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                            {delivery.customerName}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                            {delivery.address}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                            {driverName}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                            {area}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                            {(() => {
                              const date = new Date(delivery.scheduledTime);
                              const offsetMinutes = Number(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || 0);
                              const localDate = new Date(date.getTime() + offsetMinutes * 60 * 1000);
                              return `${String(localDate.getUTCHours()).padStart(2, '0')}:${String(localDate.getUTCMinutes()).padStart(2, '0')}`;
                            })()}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm">
                            <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                              normalizedStatus === 'delivered' ? 'bg-green-100 text-green-800' :
                              normalizedStatus === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                              normalizedStatus === 'assigned' ? 'bg-blue-100 text-blue-800' :
                              normalizedStatus === 'cancelled' ? 'bg-red-100 text-red-800' :
                              normalizedStatus === 'unassigned' ? 'bg-gray-100 text-gray-700' :
                              'bg-blue-100 text-blue-800'
                            }`}>
                              {statusLabel}
                            </span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm">
                            {delivery.lateMinutes > 0 && (
                              <span className="px-2 py-1 bg-red-100 text-red-800 rounded-full text-xs">
                                {delivery.lateMinutes} min late
                              </span>
                            )}
                            {delivery.earlyMinutes > 0 && (
                              <span className="px-2 py-1 bg-yellow-100 text-yellow-800 rounded-full text-xs">
                                {delivery.earlyMinutes} min early
                              </span>
                            )}
                            {delivery.lateMinutes === 0 && delivery.earlyMinutes === 0 && (
                              <span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs">
                                On Time
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Summary View */}
      {viewMode === 'summary' && (
        <>
          {/* Date Range Selector */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Date Range</h2>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Start Date
                </label>
                <input
                  type="date"
                  value={formatDateKeyLocal(dateRange.startDate)}
                  onChange={(e) => handleDateChange('startDate', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  End Date
                </label>
                <input
                  type="date"
                  value={formatDateKeyLocal(dateRange.endDate)}
                  onChange={(e) => handleDateChange('endDate', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={handleApplyFilter}
                  className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                >
                  <Filter className="w-4 h-4 mr-2 inline" />
                  Apply Filter
                </button>
              </div>
            </div>
            <div className="mt-2 text-sm text-gray-500">
              Showing data from {formatDate(dateRange.startDate)} to {formatDate(dateRange.endDate)}
            </div>
          </div>

          {/* Report Summary */}
          {reportData && reportData.summary && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Report Summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="text-center p-4 bg-blue-50 rounded-lg">
              <div className="text-2xl font-bold text-blue-600">{reportData.summary.totalDeliveries ?? 0}</div>
              <div className="text-sm text-gray-600">Total Deliveries</div>
            </div>
            <div className="text-center p-4 bg-green-50 rounded-lg">
              <div className="text-2xl font-bold text-green-600">{reportData.summary.deliveredCount ?? 0}</div>
              <div className="text-sm text-gray-600">Completed</div>
            </div>
            <div className="text-center p-4 bg-yellow-50 rounded-lg">
              <div className="text-2xl font-bold text-yellow-600">{reportData.summary.earlyDeliveries ?? 0}</div>
              <div className="text-sm text-gray-600">Early Deliveries</div>
            </div>
            <div className="text-center p-4 bg-red-50 rounded-lg">
              <div className="text-2xl font-bold text-red-600">{reportData.summary.lateDeliveries ?? 0}</div>
              <div className="text-sm text-gray-600">Late Deliveries</div>
            </div>
            <div className="text-center p-4 bg-purple-50 rounded-lg">
              <div className="text-2xl font-bold text-purple-600">{reportData.summary.accuracyRate ?? 0}%</div>
              <div className="text-sm text-gray-600">Accuracy Rate</div>
            </div>
          </div>
        </div>
      )}

      {/* Deliveries Per Day Chart */}
      {reportData && reportData.deliveriesPerDay && reportData.deliveriesPerDay.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Deliveries Per Day</h2>
          <div className="space-y-2">
            {reportData.deliveriesPerDay.map((day, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="font-medium">{new Date(day.date).toLocaleDateString()}</span>
                <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-sm">
                  {day.count} deliveries
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deliveries By Driver */}
      {reportData && reportData.deliveriesByDriver && reportData.deliveriesByDriver.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Deliveries By Driver</h2>
          <div className="space-y-2">
            {reportData.deliveriesByDriver.map((driver, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="font-medium">{driver.driver}</span>
                <span className="bg-green-100 text-green-800 px-2 py-1 rounded-full text-sm">
                  {driver.count} deliveries
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deliveries By Company */}
      {reportData && reportData.deliveriesByCompany && reportData.deliveriesByCompany.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Deliveries By Company</h2>
          <div className="space-y-2">
            {reportData.deliveriesByCompany.map((company, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="font-medium">{company.company}</span>
                <span className="bg-purple-100 text-purple-800 px-2 py-1 rounded-full text-sm">
                  {company.count} deliveries
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Late Delivery Details */}
      {reportData && reportData.lateDeliveryDetails && reportData.lateDeliveryDetails.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Late Delivery Details</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Customer Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Customer ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Address
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Late Time
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Scheduled
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {reportData.lateDeliveryDetails.map((delivery, index) => (
                  <tr key={index} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                      {delivery.customerName}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {delivery.customerId}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                      {delivery.address}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      <span className="px-2 py-1 bg-red-100 text-red-800 rounded-full">
                        {delivery.lateMinutes} min late
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {new Date(delivery.scheduledTime).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      <span className={`px-2 py-1 rounded-full text-xs ${
                        delivery.status === 'delivered' 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {delivery.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Early Delivery Details */}
      {reportData && reportData.earlyDeliveryDetails && reportData.earlyDeliveryDetails.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Early Delivery Details</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Customer Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Customer ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Address
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Early Time
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Scheduled
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {reportData.earlyDeliveryDetails.map((delivery, index) => (
                  <tr key={index} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                      {delivery.customerName}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {delivery.customerId}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                      {delivery.address}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      <span className="px-2 py-1 bg-yellow-100 text-yellow-800 rounded-full">
                        {delivery.earlyMinutes} min early
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {new Date(delivery.scheduledTime).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      <span className={`px-2 py-1 rounded-full text-xs ${
                        delivery.status === 'delivered' 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {delivery.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No Data Message */}
      {reportData && reportData.summary && reportData.summary.totalDeliveries === 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 text-yellow-500" />
          <h3 className="text-lg font-semibold text-yellow-800">No Data Found</h3>
          <p className="text-yellow-700 mt-2">
            No deliveries found for the selected date range. Try adjusting the dates.
          </p>
        </div>
      )}

      {/* Export Options - Only in Summary Mode */}
      {viewMode === 'summary' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Export Reports</h2>
          <div className="flex space-x-3">
            <button
              onClick={() => handleExport('csv')}
              className="flex items-center px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600"
            >
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </button>
            <button
              onClick={() => handleExport('pdf')}
              className="flex items-center px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
            >
              <Download className="w-4 h-4 mr-2" />
              Export PDF
            </button>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
};

export default Reports;
