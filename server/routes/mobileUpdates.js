import express from 'express';
import { mobileUpdatePolicy } from '../services/mobileUpdatePolicy.js';

const router = express.Router();
router.get('/update-policy', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: mobileUpdatePolicy() });
});
export default router;
