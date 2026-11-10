import axios from 'axios';
import { resolveApiBaseUrl } from './api';

// Public email-only menu access is separate from staff credentials and staff
// logout redirects. Its short-lived token stays in component memory only.
export default axios.create({ baseURL: resolveApiBaseUrl() });
