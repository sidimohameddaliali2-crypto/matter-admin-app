import express from 'express';
import { readFileSync } from 'node:fs';
import { protect, superAdmin } from '../middleware/auth.js';
import { recentEvents } from '../observability/recentEvents.js';

const catalog = JSON.parse(
  readFileSync(new URL('../../docs/traceability/routes.json', import.meta.url), 'utf8'),
);

// An injectable auth boundary allows isolated tests without production sessions.
export function createTraceabilityRouter({
  authenticate = protect,
  authorize = superAdmin,
  preview = false,
} = {}) {
  const router = express.Router();
  router.use(authenticate, authorize);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/catalog', (_req, res) => res.json({ success: true, data: catalog }));
  router.get('/events', (_req, res) =>
    res.json({ success: true, data: { ...recentEvents(), preview } }),
  );
  return router;
}
export default createTraceabilityRouter();
