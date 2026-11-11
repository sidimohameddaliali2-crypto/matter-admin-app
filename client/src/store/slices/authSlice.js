import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../utils/api';
import { updateUser } from './userSlice';

// Safe localStorage parsing function
const getStoredUser = () => {
  try {
    const userStr = localStorage.getItem('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch (error) {
    console.error('Error parsing stored user:', error);
    localStorage.removeItem('user');
    return null;
  }
};

const getStoredToken = () => {
  try {
    return localStorage.getItem('token');
  } catch (error) {
    console.error('Error getting stored token:', error);
    return null;
  }
};

export const login = createAsyncThunk(
  'auth/login',
  async ({ email, password }, { rejectWithValue }) => {
    try {
      const response = await api.post('/auth/login', { email, password });
      
      // Safely store in localStorage
      try {
        localStorage.setItem('token', response.data.data.token);
        localStorage.setItem('user', JSON.stringify(response.data.data.user));
      } catch (storageError) {
        console.error('Error storing auth data:', storageError);
      }
      
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data || { message: 'Login failed' });
    }
  }
);

export const refreshCurrentUser = createAsyncThunk(
  'auth/refreshCurrentUser',
  async (_, { rejectWithValue }) => {
    try {
      const response = await api.get('/auth/me');
      const freshUser = response?.data?.data?.user;

      if (freshUser) {
        try {
          localStorage.setItem('user', JSON.stringify(freshUser));
        } catch (storageError) {
          console.error('Error storing refreshed user:', storageError);
        }
      }

      return freshUser;
    } catch (error) {
      return rejectWithValue(error.response?.data || { message: 'Failed to refresh user' });
    }
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    user: getStoredUser(),
    token: getStoredToken(),
    isLoading: false,
    error: null,
  },
  reducers: {
    logout: (state) => {
      // Clear the report session together with the existing staff session.
      fetch('/api/driver-audits/session', {method:'DELETE', credentials:'same-origin', keepalive:true}).catch(()=>{});
      state.user = null;
      state.token = null;
      try {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      } catch (error) {
        console.error('Error clearing auth data:', error);
      }
    },
    clearError: (state) => {
      state.error = null;
    },
    // Add this to clear invalid data
    clearInvalidData: (state) => {
      state.user = null;
      state.token = null;
      try {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      } catch (error) {
        console.error('Error clearing invalid data:', error);
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(login.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload.data.user;
        state.token = action.payload.data.token;
      })
      .addCase(login.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload?.message || 'Login failed';
      })
      .addCase(refreshCurrentUser.fulfilled, (state, action) => {
        if (action.payload) {
          state.user = action.payload;
        }
      })
      // Sync auth user when their own record is updated (e.g. permissions changed)
      .addCase(updateUser.fulfilled, (state, action) => {
        if (state.user && state.user._id === action.payload._id) {
          state.user = action.payload;
          try {
            localStorage.setItem('user', JSON.stringify(action.payload));
          } catch (e) {}
        }
      });
  },
});

export const { logout, clearError, clearInvalidData } = authSlice.actions;
export default authSlice.reducer;
