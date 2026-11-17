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

const partnerApi = axios.create({ baseURL: resolveApiBaseUrl() });

partnerApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('partnerToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

partnerApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const backendMessage = String(error.response?.data?.message || '');
      const isAuthFailure = /not authorized|token failed|no token|partner not found|deactivated|invalid token/i.test(backendMessage);
      if (isAuthFailure) {
        localStorage.removeItem('partnerToken');
        localStorage.removeItem('partnerUser');
        window.location.href = '/partner/login';
      }
    }
    return Promise.reject(error);
  }
);

attachRequestReference(partnerApi);
attachActivityContext(partnerApi);

export default partnerApi;
