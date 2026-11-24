import axios from 'axios';

// Customer links do not need staff authentication or browser storage. In Safari,
// storage can be unavailable even though the public menu itself is accessible.
const origin = typeof window !== 'undefined' ? window.location.origin : '';
const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const configured = process.env.REACT_APP_API_URL;
const local = host === 'localhost' || host === '127.0.0.1';
const baseURL = configured && (local || !/localhost|127\.0\.0\.1/.test(configured))
  ? configured : local ? 'http://localhost:5000/api' : `${origin}/api`;

export default axios.create({ baseURL });
