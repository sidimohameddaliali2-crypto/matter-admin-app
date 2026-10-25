import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { requireDeliveryConfirmation } from '../../utils/deliveryConfirmation';
import api from '../../utils/api';

const LOCAL_TZ_OFFSET_MINUTES = parseInt(process.env.REACT_APP_LOCAL_TIMEZONE_OFFSET_MINUTES || '240', 10);
const EARLY_NEXT_DAY_ENABLED = String(process.env.REACT_APP_ENABLE_EARLY_NEXT_DAY || '1') === '1';
const NEXT_DAY_AVAILABLE_HOUR = parseInt(process.env.REACT_APP_NEXT_DAY_AVAILABLE_HOUR || '16', 10);

// Async thunks for driver mobile
export const fetchDriverDeliveries = createAsyncThunk(
  'driverMobile/fetchDriverDeliveries',
  async (_, { rejectWithValue }) => {
    try {
      const offsetMs = LOCAL_TZ_OFFSET_MINUTES * 60 * 1000;
      const nowUTC = new Date();
      const nowLocal = new Date(nowUTC.getTime() + offsetMs);

      const todayStringLocal = nowLocal.toISOString().split('T')[0];
      const localMidnight = new Date(todayStringLocal + 'T00:00:00.000Z');
      const dateFrom = new Date(localMidnight.getTime() - offsetMs);
      let dateTo = new Date(dateFrom.getTime() + 24 * 60 * 60 * 1000 - 1);

      if (EARLY_NEXT_DAY_ENABLED && nowLocal.getHours() >= NEXT_DAY_AVAILABLE_HOUR) {
        dateTo = new Date(dateFrom.getTime() + 48 * 60 * 60 * 1000 - 1);
      }
      
      console.log('[DRIVER MOBILE] Fetching deliveries', {
        currentTime: new Date().toLocaleTimeString('en-US', { hour12: true }),
        localTime: nowLocal.toLocaleTimeString('en-US', { hour12: true }),
        targetDayString: todayStringLocal,
        dateFrom: dateFrom.toISOString(),
        dateTo: dateTo.toISOString(),
        LOCAL_TZ_OFFSET_MINUTES,
        EARLY_NEXT_DAY_ENABLED,
        NEXT_DAY_AVAILABLE_HOUR
      });
      
      // Try the driver/today endpoint first, with fallback to main endpoint
      let response;
      try {
        response = await api.get('/deliveries/driver/today');
        console.log('✅ Successfully fetched from /driver/today endpoint');
      } catch (error) {
        console.log('⚠️ Fallback to main /deliveries endpoint with date parameters');
        // Fallback: use main endpoint with date filters
        response = await api.get('/deliveries', {
          params: {
            dateFrom: dateFrom.toISOString(),
            dateTo: dateTo.toISOString(),
            limit: 5000
          }
        });
      }
      
      console.log('📦 API Response:', response);
      
      // Handle nested response structure
      let deliveries = [];
      
      if (response.data && response.data.data && Array.isArray(response.data.data.deliveries)) {
        deliveries = response.data.data.deliveries;
      } else if (response.data && Array.isArray(response.data.deliveries)) {
        deliveries = response.data.deliveries;
      } else if (response.data && Array.isArray(response.data.data)) {
        deliveries = response.data.data;
      } else if (Array.isArray(response.data)) {
        deliveries = response.data;
      } else if (response.data && typeof response.data === 'object') {
        deliveries = [response.data];
      }
      
      console.log(`📋 Found ${deliveries.length} deliveries for today`);
      
      if (deliveries.length === 0) {
        console.warn('⚠️ No deliveries found for today. Checking if there are any deliveries at all...');
      }
      
      // Ensure each delivery has required fields
      const processedDeliveries = deliveries.map(delivery => ({
        _id: delivery._id,
        customerName: delivery.customerName || 'Customer',
        customerId: delivery.customerId,
        scheduledTime: delivery.scheduledTime,
        address: delivery.address || 'Address not available',
        notes: delivery.notes,
        company: delivery.company || 'Matter',
        status: delivery.status || 'pending',
        lateMinutes: delivery.lateMinutes || 0,
        proof: delivery.proof || { images: [] },
        phone: delivery.phone,
        driver: delivery.driver,
        ...delivery
      }));
      
      console.log('✅ Processed deliveries:', processedDeliveries.length);
      // Only the /driver/today endpoint knows about handoffs; the date-range
      // fallback doesn't, so this is simply empty on that path.
      const handoffs = Array.isArray(response.data?.data?.handoffs) ? response.data.data.handoffs : [];

      return { deliveries: processedDeliveries, handoffs };
    } catch (error) {
      console.error('❌ Error fetching driver deliveries:', error);
      return rejectWithValue(error.response?.data || { message: 'Failed to fetch deliveries' });
    }
  }
);

export const updateDeliveryStatus = createAsyncThunk(
  'driverMobile/updateDeliveryStatus',
  async ({ deliveryId, status, proof, bagId, bagIds }, { rejectWithValue }) => {
    try {
      const response = await api.patch(`/deliveries/${deliveryId}/status`, {
        status,
        proof,
        bagId,
        bagIds
      });
      
      console.log('Update delivery response:', response.data);
      
      // Return the updated delivery data
      return requireDeliveryConfirmation(response.data, deliveryId, status);
    } catch (error) {
      console.error('Error updating delivery status:', error);
      return rejectWithValue(error.response?.data || { message: error.message || 'Failed to update delivery status' });
    }
  }
);

const driverMobileSlice = createSlice({
  name: 'driverMobile',
  initialState: {
    deliveries: [],
    // Van↔bike meetings this driver is part of today (from /deliveries/driver/today).
    handoffs: [],
    currentDelivery: null,
    isLoading: false,
    error: null,
    success: false
  },
  reducers: {
    setCurrentDelivery: (state, action) => {
      state.currentDelivery = action.payload;
    },
    clearCurrentDelivery: (state) => {
      state.currentDelivery = null;
    },
    clearError: (state) => {
      state.error = null;
    },
    clearSuccess: (state) => {
      state.success = false;
    }
  },
  extraReducers: (builder) => {
    builder
      // Fetch driver deliveries
      .addCase(fetchDriverDeliveries.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchDriverDeliveries.fulfilled, (state, action) => {
        state.isLoading = false;
        state.deliveries = action.payload.deliveries;
        state.handoffs = action.payload.handoffs || [];
        state.error = null;
        console.log('Redux state updated with deliveries:', action.payload.deliveries);
      })
      .addCase(fetchDriverDeliveries.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload?.message || 'Failed to fetch deliveries';
        state.deliveries = [];
        state.handoffs = [];
      })
      // Update delivery status
      .addCase(updateDeliveryStatus.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(updateDeliveryStatus.fulfilled, (state, action) => {
        state.isLoading = false;
        const updatedDelivery = action.payload;
        console.log('Updated delivery received in Redux:', {
          id: updatedDelivery._id,
          status: updatedDelivery.status,
          deliveredTime: updatedDelivery.deliveredTime
        });
        const index = state.deliveries.findIndex(d => d && d._id === updatedDelivery._id);
        if (index !== -1) {
          console.log('Updating delivery at index:', index, 'Old status:', state.deliveries[index].status, 'New status:', updatedDelivery.status);
          state.deliveries[index] = updatedDelivery;
        } else {
          console.warn('Delivery not found in state array:', updatedDelivery._id);
        }
        state.success = true;
        state.currentDelivery = null;
        state.error = null;
      })
      .addCase(updateDeliveryStatus.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload?.message || 'Failed to update delivery status';
      });
  }
});

export const returnBag = createAsyncThunk(
  'driverMobile/returnBag',
  async (returnData, { rejectWithValue }) => {
    try {
      const response = await api.post('/deliveries/return-bag', returnData);
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.message || 'Failed to return bag');
    }
  }
);
export const { 
  setCurrentDelivery, 
  clearCurrentDelivery, 
  clearError, 
  clearSuccess 
} = driverMobileSlice.actions;

export default driverMobileSlice.reducer;
