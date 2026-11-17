import { protectService } from '../services/customerServiceStaffAuth.js';
import { partnerProtect } from '../middleware/partnerAuth.js';
import { memberProtect } from '../middleware/memberAuth.js';
import { formActivity } from '../observability/activityForms.js';
import { recordActivity, readActivity } from '../observability/activityStore.js';
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
  captureAuthenticate = protectService,
  activityReader = readActivity,
  activityWriter = recordActivity,
} = {}) {
  const router = express.Router();
  const capture = async (req, res) => {
    const inputs = req.body?.events;
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100)
      return res
        .status(400)
        .json({ success: false, message: 'Provide up to 100 form activities.' });
    const accepted = [];
    for (const input of inputs) {
      let event;
      try {
        event = formActivity(req, input, catalog);
      } catch {
        return res.status(400).json({
          success: false,
          accepted,
          message: 'Some form activity could not be understood.',
        });
      }
      if (!(await activityWriter(event)))
        return res.status(503).json({
          success: false,
          accepted,
          message: 'Activity could not be recorded. Retry later.',
        });
      accepted.push(input.eventId);
    }
    return res.status(202).json({ success: true, accepted });
  };
  router.post('/capture', captureAuthenticate, capture);
  router.post('/capture/partner', partnerProtect, capture);
  router.post('/capture/member', memberProtect, capture);
  router.use(authenticate, authorize);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/activity', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
      let before = null;
      if (req.query.before) {
        try {
          before = JSON.parse(Buffer.from(String(req.query.before), 'base64url').toString());
          if (
            !/^[a-f0-9-]{36}$/.test(before.eventId) ||
            !Number.isFinite(Date.parse(before.occurredAt))
          )
            throw Error('Bad cursor');
        } catch {
          return res
            .status(400)
            .json({ success: false, message: 'Load the history again before continuing.' });
        }
      }
      res.json({
        success: true,
        data: {
          ...(await activityReader({ limit, q, before, issues: req.query.issues === '1' })),
          preview,
        },
      });
    } catch {
      res
        .status(503)
        .json({ success: false, message: 'Activity history is temporarily unavailable.' });
    }
  });
  router.get('/catalog', (_req, res) => res.json({ success: true, data: catalog }));
  router.get('/events', (_req, res) =>
    res.json({ success: true, data: { ...recentEvents(), preview } }),
  );
  return router;
}
export default createTraceabilityRouter();
