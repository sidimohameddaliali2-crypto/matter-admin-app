import express from 'express';
import { randomUUID } from 'node:crypto';
import { protect, dispatcher } from '../middleware/auth.js';
import User from '../models/User.js';
import Vehicle from '../models/Vehicle.js';
import { fleetDispatchClient, fleetReviewProof, operatorAllowed, validFleetReview } from '../services/fleetDispatch.js';

const router = express.Router();
const objectId = /^[a-f0-9]{24}$/;
const kinds = new Set(['assign', 'swap', 'end', 'correct']);
const activeVehicle = { $in: ['active', 'idle'] };

router.use(protect, dispatcher, (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  if (!operatorAllowed(req.user, process.env)) return res.sendStatus(404);
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.sendStatus(403);
  req.sendFleetDispatch = fleetDispatchClient(process.env);
  if (!req.sendFleetDispatch) return res.status(503).json({ message: 'Vehicle assignments are temporarily unavailable.' });
  return next();
});

router.get('/options', async (req, res) => {
  try {
    const { vehicles } = await req.sendFleetDispatch({ phase: 'options', actorId: String(req.user._id) });
    if (!Array.isArray(vehicles) || vehicles.length > 100
        || vehicles.some(vehicle => !objectId.test(vehicle?.sourceVehicleId ?? ''))) throw Error('Invalid vehicle roster');
    const registry = new Map(vehicles.map(vehicle => [vehicle.sourceVehicleId, vehicle.vehicleClass]));
    const active = await Vehicle.find({ _id: { $in: [...registry.keys()] }, status: activeVehicle })
      .select('_id vehicleId plateNumber type').sort('vehicleId').lean();
    return res.json({ data: active
      .filter(row => row.type === registry.get(String(row._id)))
      .map(({ _id, vehicleId, plateNumber, type }) => ({ id: String(_id), label: vehicleId, plate: plateNumber, type })) });
  } catch {
    return res.status(503).json({ message: 'Vehicle assignments are temporarily unavailable.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { phase, operationId, command, reviewProof } = req.body ?? {};
    const { kind, pairs } = command ?? {};
    const actorId = String(req.user._id);
    const secret = process.env.MATTER_FLEET_LINK_SECRET;
    if (!['review', 'commit'].includes(phase) || !kinds.has(kind) || !Array.isArray(pairs)
        || pairs.length !== (kind === 'swap' ? 2 : 1)
        || pairs.some(pair => !objectId.test(pair?.driverId ?? '')
          || (kind === 'end' ? pair?.sourceVehicleId !== null : !objectId.test(pair?.sourceVehicleId ?? '')))) {
      return res.status(400).json({ message: 'Choose a driver and verified vehicle.' });
    }
    if (kind === 'correct' && (process.env.MATTER_DISPATCH_FLEET_HISTORICAL_CORRECTIONS !== '1'
        || !['super_admin', 'admin'].includes(req.user.role))) return res.sendStatus(403);
    // An operation that has reached Reports must be replayable even after a
    // later driver or vehicle change. Current roster checks happen on review.
    if (phase === 'review') {
      const driverIds = [...new Set(pairs.map(pair => pair.driverId))];
      const vehicleIds = [...new Set(pairs.map(pair => pair.sourceVehicleId).filter(Boolean))];
      const [driverCount, vehicleCount] = await Promise.all([
        User.countDocuments({ _id: { $in: driverIds }, role: 'driver', isActive: true }),
        Vehicle.countDocuments({ _id: { $in: vehicleIds }, status: activeVehicle }),
      ]);
      if (driverCount !== driverIds.length || vehicleCount !== vehicleIds.length) {
        return res.status(422).json({ message: 'Choose an active driver and an available vehicle.' });
      }
    } else if (!validFleetReview(secret, actorId, operationId, command, reviewProof)) {
      return res.status(422).json({ message: 'Review this pairing before saving it.' });
    }
    const data = await req.sendFleetDispatch({ phase, operationId, command, actorId });
    if (phase === 'commit') return res.json({ data });
    const reviewedOperation = randomUUID();
    return res.json({ data: { ...data, operationId: reviewedOperation,
      reviewProof: fleetReviewProof(secret, actorId, reviewedOperation, { ...command,
        expected: data.expected, expectedAssets: data.expectedAssets }) } });
  } catch (error) {
    if (error.status === 409 || error.status === 422) return res.status(error.status).json({ message: error.message });
    return res.status(503).json({ message: 'Vehicle save could not be confirmed. Retry this same request.' });
  }
});

export default router;
