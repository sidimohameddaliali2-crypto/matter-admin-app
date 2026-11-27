import express from 'express';
import { protect, dispatcher } from '../middleware/auth.js';
import { fleetRoster, fleetUnavailable, operatorAllowed } from '../services/fleetDispatch.js';
import { dispatchFleet, readDispatchOptions } from '../services/fleetDispatchStore.js';
import { reportingCaptureEnabled } from '../services/reportingOutbox.js';

const router = express.Router();

router.use(protect, dispatcher, (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  if (!operatorAllowed(req.user, process.env)) return res.sendStatus(404);
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.sendStatus(403);
  if (req.get('x-matter-fleet-actor') !== String(req.user._id)) {
    return res.status(403).json({ message: 'The Dispatch account changed. Reload to continue with the current account.' });
  }
  try {
    const secret = process.env.MATTER_FLEET_LINK_SECRET;
    if (!reportingCaptureEnabled() || !/^[\x21-\x7e]{32,256}$/.test(secret ?? '')) throw fleetUnavailable();
    req.fleetDispatch = { actorId: String(req.user._id), secret, roster: fleetRoster() };
    return next();
  } catch {
    return res.status(503).json({ message: fleetUnavailable().message });
  }
});

router.get('/options', async (req, res) => {
  try {
    return res.json(await readDispatchOptions(req.fleetDispatch.roster));
  } catch {
    return res.status(503).json({ message: fleetUnavailable().message });
  }
});

router.post('/', async (req, res) => {
  try {
    return res.json({ data: await dispatchFleet(req.body ?? {}, req.fleetDispatch) });
  } catch (error) {
    if ([400, 403, 409, 422].includes(error.status)) return res.status(error.status).json({ message: error.message });
    return res.status(503).json({ message: 'Vehicle save could not be confirmed. Retry this same request.' });
  }
});

export default router;
