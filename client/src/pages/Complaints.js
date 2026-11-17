import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { AlertTriangle, Download, X } from 'lucide-react';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';

const Complaints = () => {
  const [complaints, setComplaints] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [complaintTypeFilter, setComplaintTypeFilter] = useState('all');
  const [resolvedFilter, setResolvedFilter] = useState('all');
  // Empty = "All Dates" (every complaint, not just today's) — the default,
  // since that's the view people actually land on this page looking for.
  const [selectedDate, setSelectedDate] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [sortBy, setSortBy] = useState('reportedAt');
  const [sortOrder, setSortOrder] = useState(-1);
  const [selectedComplaints, setSelectedComplaints] = useState([]);

  // Manual complaint modal state
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [manualCustomerName, setManualCustomerName] = useState('');
  const [manualComplaintType, setManualComplaintType] = useState('');
  const [manualRemarks, setManualRemarks] = useState('');
  const [manualCompType, setManualCompType] = useState('');
  const [manualRefundAmount, setManualRefundAmount] = useState('');
  const [manualExtraDays, setManualExtraDays] = useState('');
  const [isSubmittingManual, setIsSubmittingManual] = useState(false);

  const complaintTypes = [
    { value: 'all', label: 'All Types' },
    { value: 'late', label: 'Late Delivery' },
    { value: 'early', label: 'Early Delivery' },
    { value: 'missed', label: 'Missed Delivery' },
    { value: 'wrong_address', label: 'Wrong Address' },
    { value: 'delivery_issue', label: 'Delivery Issue' },
    { value: 'food_quality', label: 'Food Quality' },
    { value: 'major_incident', label: 'Major Incident' },
    { value: 'damaged_food', label: 'Damaged Food' },
    { value: 'macros_inaccuracy', label: 'Macros Inaccuracy' },
    { value: 'late_delivery_transcorp', label: 'Late delivery - Transcorp' },
    { value: 'wrong_food', label: 'Wrong Food' },
    { value: 'other', label: 'Other' }
  ];

  // Export modal state
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const complaintTypesForForm = complaintTypes.filter(ct => ct.value !== 'all');
  const [exportSelectedTypes, setExportSelectedTypes] = useState(() => complaintTypesForForm.map(ct => ct.value));
  const [exportDateFrom, setExportDateFrom] = useState('');
  const [exportDateTo, setExportDateTo] = useState('');

  const resetManualForm = () => {
    setManualCustomerName('');
    setManualComplaintType('');
    setManualRemarks('');
    setManualCompType('');
    setManualRefundAmount('');
    setManualExtraDays('');
  };

  const submitManualComplaint = async (e) => {
    e.preventDefault();
    if (!manualCustomerName.trim()) {
      alert('Please enter a Customer Name');
      return;
    }
    if (!manualComplaintType) {
      alert('Please select a complaint type');
      return;
    }
    if (manualCompType === 'refund' && !manualRefundAmount) {
      alert('Please enter refund amount');
      return;
    }
    if (manualCompType === 'extra_day' && !manualExtraDays) {
      alert('Please enter number of extra days');
      return;
    }

    try {
      setIsSubmittingManual(true);
      // Find a delivery for this customer name (most recent within 7 days)
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const searchResp = await api.get('/deliveries', {
        params: {
          limit: 1,
          search: manualCustomerName,
          dateFrom: weekAgo.toISOString(),
          dateTo: now.toISOString(),
        },
      });

      const deliveriesList = searchResp.data?.data?.deliveries || [];
      if (deliveriesList.length === 0) {
        alert('No delivery found for that customer in the last 7 days. Please check the name.');
        return;
      }

      const targetDeliveryId = deliveriesList[0]._id;

      const payload = {
        complaint: {
          complaintType: manualComplaintType,
          remarks: manualRemarks || undefined,
          compensation: manualCompType
            ? {
                type: manualCompType,
                amount: manualCompType === 'refund' ? parseFloat(manualRefundAmount) : undefined,
                days: manualCompType === 'extra_day' ? parseInt(manualExtraDays) : undefined,
              }
            : undefined,
        },
      };

      await api.post(`/deliveries/${targetDeliveryId}/report-issue`, payload);
      setIsManualOpen(false);
      resetManualForm();
      // Refresh list
      fetchComplaints();
    } catch (err) {
      console.error('Manual complaint submit error:', err);
      alert(err.response?.data?.message || 'Failed to submit complaint');
    } finally {
      setIsSubmittingManual(false);
    }
  };

  const fetchComplaints = useCallback(async () => {
    try {
      const isFirstPage = currentPage === 1;
      if (isFirstPage) setIsLoading(true);
      else setIsLoadingMore(true);
      setError(null);

      const params = {
        page: currentPage,
        limit: 20,
        sortBy,
        sortOrder
      };

      // Only add date filter if a specific date is selected
      if (selectedDate) {
        const dateStart = new Date(selectedDate);
        const dateEnd = new Date(selectedDate);
        dateEnd.setDate(dateEnd.getDate() + 1);
        
        params.reportedDateFrom = dateStart.toISOString();
        params.reportedDateTo = dateEnd.toISOString();
      }

      if (complaintTypeFilter !== 'all') {
        params.complaintType = complaintTypeFilter;
      }

      if (resolvedFilter !== 'all') {
        params.resolved = resolvedFilter === 'resolved';
      }

      if (searchTerm) {
        params.search = searchTerm;
      }

      console.log('Fetching complaints with params:', params);
      const response = await api.get('/deliveries/complaints/all', { params });
      console.log('Complaints response:', response.data);

      setComplaints((prev) =>
        currentPage === 1 ? response.data.data.complaints : [...prev, ...response.data.data.complaints]
      );
      setTotalPages(response.data.data.pagination.pages);
    } catch (err) {
      console.error('Fetch complaints error:', err);
      setError(err.response?.data?.message || 'Failed to fetch complaints');
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [currentPage, complaintTypeFilter, resolvedFilter, searchTerm, sortBy, sortOrder, selectedDate]);

  useEffect(() => {
    fetchComplaints();
  }, [fetchComplaints]);

  // Clear selections when filters change (not when "Load More" appends to the list)
  useEffect(() => {
    setSelectedComplaints([]);
  }, [complaintTypeFilter, resolvedFilter, searchTerm, sortBy, sortOrder, selectedDate]);

  const toggleSelectComplaint = (complaintId) => {
    setSelectedComplaints(prev => 
      prev.includes(complaintId)
        ? prev.filter(id => id !== complaintId)
        : [...prev, complaintId]
    );
  };

  const toggleExportType = (value) => {
    setExportSelectedTypes(prev =>
      prev.includes(value)
        ? prev.filter(v => v !== value)
        : [...prev, value]
    );
  };

  const changeExportTypes = next => {
    const names = values => values.map(value => complaintTypesForForm.find(type => type.value === value)?.label || value);
    recordActivityChange({ field: 'Complaint export types', before: names(exportSelectedTypes), after: names(next), form: 'Export complaints' }); setExportSelectedTypes(next);
  };
  const selectAllExportTypes = () => changeExportTypes(complaintTypesForForm.map(type => type.value));
  const clearExportTypes = () => changeExportTypes([]);

  const toggleSelectAll = () => {
    if (selectedComplaints.length === complaints.length) {
      setSelectedComplaints([]);
    } else {
      setSelectedComplaints(complaints.map(c => c._id));
    }
  };

  const getComplaintTypeLabel = (type) => {
    const labels = {
      late: 'Late Delivery',
      early: 'Early Delivery',
      missed: 'Missed Delivery',
      wrong_address: 'Wrong Address',
      delivery_issue: 'Delivery Issue',
      food_quality: 'Food Quality',
      major_incident: 'Major Incident',
      damaged_food: 'Damaged Food',
      macros_inaccuracy: 'Macros Inaccuracy',
      late_delivery_transcorp: 'Late delivery - Transcorp',
      wrong_food: 'Wrong Food',
      other: 'Other'
    };
    return labels[type] || type;
  };

  const getComplaintTypeColor = (type) => {
    const colors = {
      late: 'bg-red-100 text-red-800',
      early: 'bg-yellow-100 text-yellow-800',
      missed: 'bg-purple-100 text-purple-800',
      wrong_address: 'bg-orange-100 text-orange-800',
      delivery_issue: 'bg-pink-100 text-pink-800',
      food_quality: 'bg-amber-100 text-amber-800',
      major_incident: 'bg-rose-100 text-rose-800',
      damaged_food: 'bg-red-100 text-red-800',
      macros_inaccuracy: 'bg-indigo-100 text-indigo-800',
      late_delivery_transcorp: 'bg-orange-100 text-orange-800',
      wrong_food: 'bg-yellow-100 text-yellow-800',
      other: 'bg-gray-100 text-gray-800'
    };
    return colors[type] || 'bg-gray-100 text-gray-800';
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const offsetMinutes = Number(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || 0);
    const localDate = new Date(date.getTime() + offsetMinutes * 60 * 1000);
    
    const year = localDate.getUTCFullYear();
    const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(localDate.getUTCDate()).padStart(2, '0');
    const hours = String(localDate.getUTCHours()).padStart(2, '0');
    const minutes = String(localDate.getUTCMinutes()).padStart(2, '0');
    
    return `${month}/${day}/${year} ${hours}:${minutes}`;
  };

  const formatRelativeDate = (dateString) => {
    if (!dateString) return 'N/A';
    const offsetMinutes = Number(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || 0);
    const date = new Date(new Date(dateString).getTime() + offsetMinutes * 60 * 1000);
    const now = new Date(Date.now() + offsetMinutes * 60 * 1000);

    const dayKey = (d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    if (dayKey(date) === dayKey(now)) {
      const hours = date.getUTCHours();
      const minutes = String(date.getUTCMinutes()).padStart(2, '0');
      const period = hours >= 12 ? 'PM' : 'AM';
      const hour12 = hours % 12 === 0 ? 12 : hours % 12;
      return `Today, ${hour12}:${minutes} ${period}`;
    }
    if (dayKey(date) === dayKey(oneDayAgo)) return 'Yesterday';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };

  const getComplaintTypeDotColor = (type) => {
    const colors = {
      late: 'bg-red-500',
      early: 'bg-yellow-500',
      missed: 'bg-purple-500',
      wrong_address: 'bg-orange-500',
      delivery_issue: 'bg-pink-500',
      food_quality: 'bg-amber-500',
      major_incident: 'bg-rose-500',
      damaged_food: 'bg-red-500',
      macros_inaccuracy: 'bg-indigo-500',
      late_delivery_transcorp: 'bg-orange-500',
      wrong_food: 'bg-yellow-500',
      other: 'bg-gray-400'
    };
    return colors[type] || 'bg-gray-400';
  };

  const getStatusMeta = (resolved) => (
    resolved
      ? { label: 'Resolved', icon: 'check_circle', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
      : { label: 'Pending', icon: 'schedule', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
  );

  const exportToExcel = () => {
    if (exportSelectedTypes.length === 0) {
      alert('Please select at least one complaint type');
      return;
    }

    const complaintsBase = selectedComplaints.length > 0
      ? complaints.filter(c => selectedComplaints.includes(c._id))
      : complaints;

    const dateFrom = exportDateFrom ? new Date(exportDateFrom) : null;
    const dateTo = exportDateTo ? new Date(exportDateTo) : null;
    if (dateTo) {
      dateTo.setHours(23, 59, 59, 999);
    }

    const filtered = complaintsBase.filter((complaint) => {
      const type = complaint.complaint?.complaintType || 'other';
      if (!exportSelectedTypes.includes(type)) return false;

      if (!dateFrom && !dateTo) return true;
      const dateString = complaint.complaint?.reportedAt || complaint.createdAt;
      if (!dateString) return false;
      const d = new Date(dateString);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });

    if (filtered.length === 0) {
      alert('No complaints match the selected filters');
      return;
    }

    const rows = filtered.map((complaint) => {
      const driverName = complaint.driver?.profile
        ? `${complaint.driver.profile.firstName || ''} ${complaint.driver.profile.lastName || ''}`.trim()
        : complaint.driver?.name || 'N/A';

      const complaintType = complaint.complaint?.complaintType || 'other';
      const remarks = complaint.complaint?.remarks || 'No remarks';
      const date = complaint.complaint?.reportedAt || complaint.createdAt || '';
      const resolved = complaint.complaint?.resolved || false;

      const compensation = complaint.complaint?.compensation
        ? (complaint.complaint.compensation.type === 'refund'
            ? `Refund: $${complaint.complaint.compensation.amount || 0}`
            : complaint.complaint.compensation.type === 'discount'
              ? `Discount: ${complaint.complaint.compensation.amount || 0}%`
              : complaint.complaint.compensation.type === 'credit'
                ? `Credit: $${complaint.complaint.compensation.amount || 0}`
                : complaint.complaint.compensation.type === 'extra_day'
                  ? `Extra Day(s): ${complaint.complaint.compensation.days || 0}`
                  : 'None')
        : 'None';

      return {
        Date: formatDate(date),
        Customer: complaint.customerName || 'N/A',
        CustomerID: complaint.customerId || 'N/A',
        Driver: driverName,
        Type: getComplaintTypeLabel(complaintType),
        Remarks: remarks,
        Compensation: compensation,
        Status: resolved ? 'Resolved' : 'Pending'
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Complaints');
    XLSX.writeFile(workbook, `complaints-${exportDateFrom || 'all'}_${exportDateTo || 'all'}.xlsx`);
    setIsExportModalOpen(false);
  };

  const exportToPDF = () => {
    try {
      // Use selected complaints if any are selected, otherwise use all
      const complaintsToExport = selectedComplaints.length > 0
        ? complaints.filter(c => selectedComplaints.includes(c._id))
        : complaints;

      if (complaintsToExport.length === 0) {
        alert('No complaints to export');
        return;
      }

      // Get logo URL - try to use absolute path
      const logoUrl = `${window.location.origin}/logo.svg`;
      
      // Create a simple table layout for printing
      const printWindow = window.open('', '_blank');
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Complaints Report - ${selectedDate || 'All Time'}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .header { display: flex; align-items: center; gap: 20px; margin-bottom: 30px; border-bottom: 2px solid #e5e7eb; padding-bottom: 20px; }
            .logo { width: 80px; height: 80px; object-fit: contain; }
            .header-text h1 { color: #1f2937; margin: 0 0 5px 0; font-size: 28px; }
            .header-text p { color: #6b7280; margin: 0; font-size: 14px; }
            .meta { color: #6b7280; margin-bottom: 20px; background-color: #f9fafb; padding: 15px; border-radius: 8px; }
            .meta p { margin: 5px 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th { background-color: #f3f4f6; padding: 12px; text-align: left; border: 1px solid #e5e7eb; font-weight: 600; }
            td { padding: 10px; border: 1px solid #e5e7eb; font-size: 13px; }
            tr:nth-child(even) { background-color: #f9fafb; }
            .status-resolved { color: #059669; font-weight: 500; }
            .status-pending { color: #dc2626; font-weight: 500; }
            .type-badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
            .type-late { background-color: #fee2e2; color: #991b1b; }
            .type-early { background-color: #fef3c7; color: #92400e; }
            .type-missed { background-color: #e9d5ff; color: #6b21a8; }
            .type-wrong { background-color: #fed7aa; color: #9a3412; }
            .type-issue { background-color: #fce7f3; color: #9f1239; }
            .type-other { background-color: #f3f4f6; color: #374151; }
            @media print {
              button { display: none; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <img src="${logoUrl}" alt="Logo" class="logo" onerror="this.style.display='none'" />
            <div class="header-text">
              <h1>Complaints Report</h1>
              <p>Matter Delivery Management System</p>
            </div>
          </div>
          <div class="meta">
            <p><strong>Report Date:</strong> ${selectedDate || 'All Time'}</p>
            <p><strong>Total Complaints:</strong> ${complaintsToExport.length}${selectedComplaints.length > 0 ? ` (Selected)` : ''}</p>
            <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
          </div>
          <button onclick="window.print()" style="padding: 10px 20px; background-color: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 20px;">Print / Save as PDF</button>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Customer ID</th>
                <th>Driver</th>
                <th>Type</th>
                <th>Remarks</th>
                <th>Compensation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${complaintsToExport.map(complaint => {
                const driverName = complaint.driver?.profile 
                  ? `${complaint.driver.profile.firstName || ''} ${complaint.driver.profile.lastName || ''}`.trim()
                  : complaint.driver?.name || 'N/A';
                
                const complaintType = complaint.complaint?.complaintType || 'other';
                const remarks = complaint.complaint?.remarks || 'No remarks';
                const date = complaint.complaint?.reportedAt || complaint.createdAt || '';
                const resolved = complaint.complaint?.resolved || false;
                
                const compensation = complaint.complaint?.compensation 
                  ? (complaint.complaint.compensation.type === 'refund' 
                      ? `Refund: $${complaint.complaint.compensation.amount || 0}` 
                      : complaint.complaint.compensation.type === 'discount'
                      ? `Discount: ${complaint.complaint.compensation.amount || 0}%`
                      : complaint.complaint.compensation.type === 'credit'
                      ? `Credit: $${complaint.complaint.compensation.amount || 0}`
                      : 'None')
                  : 'None';
                
                return `
                  <tr>
                    <td>${formatDate(date)}</td>
                    <td>${complaint.customerName || 'N/A'}</td>
                    <td>${complaint.customerId || 'N/A'}</td>
                    <td>${driverName}</td>
                    <td><span class="type-badge type-${complaintType}">${getComplaintTypeLabel(complaintType)}</span></td>
                    <td>${remarks}</td>
                    <td>${compensation}</td>
                    <td class="${resolved ? 'status-resolved' : 'status-pending'}">${resolved ? 'Resolved' : 'Pending'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </body>
        </html>
      `;
      printWindow.document.write(html);
      printWindow.document.close();
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  return (
    <>
    <div className="matter-analytics min-h-screen bg-gray-50 p-4 sm:p-6">
      <div className="max-w-7xl mx-auto">
        {/* Search */}
        <div className="relative mb-4 max-w-md">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">search</span>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1);
            }}
            placeholder="Search complaints, IDs, or customers..."
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        {/* Toolbar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[18px] pointer-events-none">calendar_today</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value);
                  setCurrentPage(1);
                }}
                title={selectedDate ? `Showing ${selectedDate}` : 'Showing all dates'}
                className="pl-8 pr-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {selectedDate ? (
              <button
                onClick={() => { setSelectedDate(''); setCurrentPage(1); }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-100 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
                All Dates
              </button>
            ) : (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-50 rounded-lg border border-blue-200 text-xs font-medium text-blue-700">
                Showing all dates
              </span>
            )}

            <div className="relative">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[18px] pointer-events-none">category</span>
              <select
                value={complaintTypeFilter}
                onChange={(e) => {
                  setComplaintTypeFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="appearance-none pl-8 pr-7 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {complaintTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 text-[18px] pointer-events-none">arrow_drop_down</span>
            </div>

            <div className="relative">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[18px] pointer-events-none">filter_list</span>
              <select
                value={resolvedFilter}
                onChange={(e) => {
                  setResolvedFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="appearance-none pl-8 pr-7 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="all">All Status</option>
                <option value="unresolved">Unresolved</option>
                <option value="resolved">Resolved</option>
              </select>
              <span className="material-symbols-outlined absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 text-[18px] pointer-events-none">arrow_drop_down</span>
            </div>

            <div className="relative">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[18px] pointer-events-none">sort</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="appearance-none pl-8 pr-7 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="reportedAt">Recent First</option>
                <option value="customerName">Customer Name</option>
              </select>
              <span className="material-symbols-outlined absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 text-[18px] pointer-events-none">arrow_drop_down</span>
            </div>

            {resolvedFilter !== 'all' && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 rounded-full border border-gray-200">
                <span className="text-xs text-gray-600">Status: {resolvedFilter === 'resolved' ? 'Resolved' : 'Unresolved'}</span>
                <button
                  onClick={() => { setResolvedFilter('all'); setCurrentPage(1); }}
                  className="text-gray-400 hover:text-gray-700 flex items-center justify-center rounded-full p-0.5 hover:bg-gray-200 transition-colors"
                >
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              </div>
            )}

            {selectedComplaints.length > 0 && (
              <span className="text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-full">
                {selectedComplaints.length} selected
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              onClick={exportToPDF}
              disabled={complaints.length === 0}
              className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-blue-600 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Download className="w-4 h-4" />
              {selectedComplaints.length > 0 ? 'PDF Selected' : 'PDF Report'}
            </button>
            <button
              onClick={() => setIsExportModalOpen(true)}
              disabled={complaints.length === 0}
              className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-emerald-600 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Download className="w-4 h-4" />
              {selectedComplaints.length > 0 ? 'Excel Selected' : 'Excel Report'}
            </button>
            <button
              onClick={() => setIsManualOpen(true)}
              className="flex items-center justify-center gap-2 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity shadow-sm"
            >
              <span className="material-symbols-outlined text-[18px]">add_circle</span>
              Add Complaint
            </button>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Loading complaints...</p>
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800">{error}</p>
          </div>
        ) : complaints.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <AlertTriangle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">No complaints found</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3">
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer w-fit">
                <input
                  type="checkbox"
                  checked={selectedComplaints.length === complaints.length && complaints.length > 0}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                Select all loaded
              </label>
            </div>

            {/* Bento Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {complaints.map((complaint) => {
                const resolved = !!complaint.complaint?.resolved;
                const status = getStatusMeta(resolved);
                const complaintType = complaint.complaint?.complaintType;
                const shortId = `CMP-${(complaint._id || '').slice(-6).toUpperCase()}`;
                const driverName = complaint.driver?.profile
                  ? `${complaint.driver.profile.firstName || ''} ${complaint.driver.profile.lastName || ''}`.trim()
                  : complaint.driver?.name;
                const isSelected = selectedComplaints.includes(complaint._id);

                return (
                  <div
                    key={complaint._id}
                    className={`bg-white border rounded-xl p-5 flex flex-col relative overflow-hidden shadow-sm transition-colors ${
                      resolved ? 'border-gray-200 opacity-80 hover:opacity-100' : 'border-red-200 hover:border-red-300'
                    }`}
                  >
                    {!resolved && <div className="absolute top-0 left-0 w-full h-1 bg-red-500" />}

                    <div className="flex justify-between items-start mb-4 gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectComplaint(complaint._id)}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500 flex-shrink-0"
                        />
                        <span className="font-mono text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">{shortId}</span>
                        <span className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold border ${status.cls}`}>
                          <span className="material-symbols-outlined text-[14px]">{status.icon}</span>
                          {status.label.toUpperCase()}
                        </span>
                      </div>
                      <span className="text-[11px] text-gray-400 whitespace-nowrap flex-shrink-0">
                        {formatRelativeDate(complaint.complaint?.reportedAt || complaint.updatedAt)}
                      </span>
                    </div>

                    <div className="mb-4 flex-1">
                      <h3 className="text-base font-semibold text-gray-900 mb-1 line-clamp-1">{complaint.customerName || 'Unknown Customer'}</h3>
                      <p className="text-sm text-gray-500 line-clamp-2">{complaint.complaint?.remarks || 'No remarks provided.'}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 mb-4">
                      {complaintType ? (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-50 rounded-md border border-gray-200">
                          <span className={`w-2 h-2 rounded-full ${getComplaintTypeDotColor(complaintType)}`} />
                          <span className="text-[11px] text-gray-600">{getComplaintTypeLabel(complaintType)}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-50 rounded-md border border-gray-200">
                          <span className="text-[11px] text-gray-500">No Type</span>
                        </div>
                      )}
                      {complaint.zone && (
                        <div className="flex items-center gap-1.5 text-gray-400">
                          <span className="material-symbols-outlined text-[16px]">map</span>
                          <span className="text-xs">{complaint.zone}</span>
                        </div>
                      )}
                      {complaint.complaint?.compensation && (
                        <div className="flex items-center gap-1.5 text-emerald-700">
                          <span className="text-xs font-medium">
                            {complaint.complaint.compensation.type === 'refund'
                              ? `💰 AED ${complaint.complaint.compensation.amount}`
                              : `📅 ${complaint.complaint.compensation.days} day(s)`}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="pt-4 border-t border-gray-100 flex justify-between items-center">
                      {driverName ? (
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center text-[10px] font-bold text-blue-600">
                            {driverName.slice(0, 2).toUpperCase()}
                          </div>
                          <span className="text-[11px] text-gray-500">Assigned to {driverName}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full border border-dashed border-gray-300 flex items-center justify-center text-gray-400">
                            <span className="material-symbols-outlined text-[14px]">person_add</span>
                          </div>
                          <span className="text-[11px] text-gray-400 italic">Unassigned</span>
                        </div>
                      )}
                      <Link
                        to={`/deliveries/${complaint._id}`}
                        className="text-sm font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors"
                      >
                        View Details
                        <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Load More */}
            {currentPage < totalPages && (
              <div className="mt-8 flex justify-center">
                <button
                  onClick={() => setCurrentPage((p) => p + 1)}
                  disabled={isLoadingMore}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60 transition-colors bg-white shadow-sm"
                >
                  {isLoadingMore ? 'Loading…' : 'Load More Complaints'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    {/* Manual Complaint Modal */}
    {isManualOpen && (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg w-full max-w-lg max-h-screen overflow-y-auto">
          <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Add Manual Complaint</h2>
            <button
              onClick={() => { setIsManualOpen(false); resetManualForm(); }}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <form onSubmit={submitManualComplaint} className="p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Customer Name *</label>
              <input
                type="text"
                value={manualCustomerName}
                onChange={(e) => setManualCustomerName(e.target.value)}
                placeholder="Enter customer name"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">We'll locate a recent delivery for this customer.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Complaint Type *</label>
              <select
                value={manualComplaintType}
                onChange={(e) => setManualComplaintType(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Select complaint type</option>
                {complaintTypesForForm.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Remarks</label>
              <textarea
                value={manualRemarks}
                onChange={(e) => setManualRemarks(e.target.value)}
                rows={4}
                placeholder="Describe the issue in detail..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Compensation (Optional)</label>
              <div className="space-y-2">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="manualComp"
                    value=""
                    checked={manualCompType === ''}
                    onChange={(e) => setManualCompType(e.target.value)}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">None</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="manualComp"
                    value="refund"
                    checked={manualCompType === 'refund'}
                    onChange={(e) => setManualCompType(e.target.value)}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">Refund</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="manualComp"
                    value="extra_day"
                    checked={manualCompType === 'extra_day'}
                    onChange={(e) => setManualCompType(e.target.value)}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">Extra Day</span>
                </label>
              </div>
            </div>

            {manualCompType === 'refund' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Refund Amount (AED) *</label>
                <input
                  type="number"
                  value={manualRefundAmount}
                  onChange={(e) => setManualRefundAmount(e.target.value)}
                  step="0.01"
                  min="0"
                  placeholder="Enter refund amount"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            )}

            {manualCompType === 'extra_day' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Number of Extra Days *</label>
                <input
                  type="number"
                  value={manualExtraDays}
                  onChange={(e) => setManualExtraDays(e.target.value)}
                  min="1"
                  placeholder="Enter number of days"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setIsManualOpen(false); resetManualForm(); }}
                disabled={isSubmittingManual}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:bg-gray-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingManual}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-red-300"
              >
                {isSubmittingManual ? 'Submitting...' : 'Submit Complaint'}
              </button>
            </div>
          </form>
        </div>
      </div>
    )}

    {/* Export to Excel Modal */}
    {isExportModalOpen && (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg w-full max-w-xl max-h-screen overflow-y-auto">
          <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Export Complaints to Excel</h2>
            <button
              onClick={() => setIsExportModalOpen(false)}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Date From</label>
                <input
                  type="date"
                  value={exportDateFrom}
                  onChange={(e) => setExportDateFrom(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Date To</label>
                <input
                  type="date"
                  value={exportDateTo}
                  onChange={(e) => setExportDateTo(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">Complaint Types</label>
                <div className="flex items-center gap-2 text-sm">
                  <button type="button" onClick={selectAllExportTypes} className="text-blue-600 hover:underline">Select All</button>
                  <button type="button" onClick={clearExportTypes} className="text-gray-600 hover:underline">Clear</button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {complaintTypesForForm.map((type) => (
                  <label key={type.value} className="flex items-center gap-2 text-sm text-gray-800 border border-gray-200 rounded-lg px-3 py-2">
                    <input
                      type="checkbox"
                      checked={exportSelectedTypes.includes(type.value)}
                      onChange={() => toggleExportType(type.value)}
                      className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                    />
                    <span>{type.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsExportModalOpen(false)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={exportToExcel}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                Export
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default Complaints;
