import axios from 'axios';

const resolveApiBaseUrl = () => {
  if (process.env.REACT_APP_API_URL) {
    const envUrl = process.env.REACT_APP_API_URL;
    if (typeof window !== 'undefined') {
      const host = window.location.hostname;
      if ((host !== 'localhost' && host !== '127.0.0.1') && /localhost|127\.0\.0\.1/.test(envUrl)) {
        return `${window.location.origin}/api`;
      }
    }
    return envUrl;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'http://localhost:5000/api';
    }
    return `${window.location.origin}/api`;
  }
  return 'http://localhost:5000/api';
};

const API_BASE_URL = resolveApiBaseUrl();

const api = axios.create({
  baseURL: API_BASE_URL,
});

// Add token to requests
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Handle responses and errors
api.interceptors.response.use(
  (response) => {
    const rotated = response.headers?.['x-customer-service-session'];
    if (typeof rotated === 'string' && rotated.startsWith('cs-sb.') && localStorage.getItem('token')?.startsWith('cs-sb.')) localStorage.setItem('token', rotated);
    return response;
  },
  (error) => {
    // Log API errors for debugging
    if (error.response) {
      console.error('API Error:', {
        url: error.config?.url,
        method: error.config?.method,
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    }

    // Only force logout for actual app-auth failures.
    // Do not logout on third-party/API 401s (e.g., Shopify token issues).
    if (error.response?.status === 401) {
      const requestUrl = String(error.config?.url || '');
      const backendMessage = String(error.response?.data?.message || error.response?.data?.error || '');
      const isAuthEndpoint = /\/auth\/(me|profile|change-password|refresh)/.test(requestUrl);
      const isAuthFailureMessage = /not authorized|token failed|no token|user not found|deactivated/i.test(backendMessage);

      if (isAuthEndpoint || isAuthFailureMessage) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
    }

    // Handle access denied
    if (error.response?.status === 403) {
      console.error('Access denied:', error.response.data);
      // You can show a notification here
    }

    return Promise.reject(error);
  }
);

export default api;