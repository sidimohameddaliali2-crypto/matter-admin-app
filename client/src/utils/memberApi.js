import { attachActivityContext } from './activityCapture';
import { attachRequestReference } from './requestReference';
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

const memberApi = axios.create({ baseURL: resolveApiBaseUrl() });

memberApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('memberToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

memberApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const backendMessage = String(error.response?.data?.message || '');
      const isAuthFailure = /not authorized|token failed|no token|member not found|deactivated|invalid token|partner account is unavailable/i.test(backendMessage);
      if (isAuthFailure) {
        localStorage.removeItem('memberToken');
        localStorage.removeItem('memberUser');
        // No member login page — fall back to the join link if we have one, else home.
        window.location.href = localStorage.getItem('memberInvitePath') || '/';
      }
    }
    return Promise.reject(error);
  }
);

attachRequestReference(memberApi);
attachActivityContext(memberApi);

export default memberApi;
