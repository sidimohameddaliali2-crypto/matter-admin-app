import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../utils/api';

// The report API treats "YYYY-MM-DD" as a Dubai business date and owns the
// timezone math (server/utils/businessDate.js). Sending the picked calendar
// date — not browser-local midnight as an ISO instant — keeps reports correct
// even when the browser isn't on Dubai time.
const toDateKey = (value) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const fetchReportData = createAsyncThunk(
  'reports/fetchReportData',
  async (dateRange, { rejectWithValue }) => {
    try {
      const { startDate, endDate } = dateRange;

      const response = await api.get('/reports', {
        params: {
          startDate: toDateKey(startDate),
          endDate: toDateKey(endDate)
        }
      });
      
      return response.data.data || response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data || { message: 'Failed to fetch report data' });
    }
  }
);

export const exportReport = createAsyncThunk(
  'reports/exportReport',
  async ({ format, dateRange }, { rejectWithValue }) => {
    try {
      const { startDate, endDate } = dateRange;
      
      const response = await api.get(`/reports/export/${format}`, {
        params: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        },
        responseType: format === 'csv' ? 'blob' : 'arraybuffer'
      });
      
      return { data: response.data, format };
    } catch (error) {
      return rejectWithValue(error.response?.data || { message: 'Failed to export report' });
    }
  }
);

const reportSlice = createSlice({
  name: 'reports',
  initialState: {
    reportData: null,
    isLoading: false,
    error: null,
    exportLoading: false
  },
  reducers: {
    clearError: (state) => {
      state.error = null;
    },
    clearReportData: (state) => {
      state.reportData = null;
    }
  },
  extraReducers: (builder) => {
    builder
      // Fetch report data
      .addCase(fetchReportData.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchReportData.fulfilled, (state, action) => {
        state.isLoading = false;
        state.reportData = action.payload;
      })
      .addCase(fetchReportData.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload?.message || 'Failed to fetch report data';
      })
      // Export report
      .addCase(exportReport.pending, (state) => {
        state.exportLoading = true;
      })
      .addCase(exportReport.fulfilled, (state, action) => {
        state.exportLoading = false;
        // Handle file download
        const { data, format } = action.payload;
        const blob = new Blob([data]);
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `delivery-report-${new Date().toISOString().split('T')[0]}.${format}`;
        link.click();
        window.URL.revokeObjectURL(url);
      })
      .addCase(exportReport.rejected, (state, action) => {
        state.exportLoading = false;
        state.error = action.payload?.message || 'Failed to export report';
      });
  }
});

export const { clearError, clearReportData } = reportSlice.actions;
export default reportSlice.reducer;