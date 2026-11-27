import express from 'express';
import { protect, dispatcher } from '../middleware/auth.js';
import User from '../models/User.js';
import Vehicle from '../models/Vehicle.js';
import { confirmedFleetVehicles, dispatchFleet, fleetDispatchClient, operatorAllowed } from '../services/fleetDispatch.js';

const router = express.Router();
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
    const { vehicles, currentDriverIds } = await req.sendFleetDispatch({ phase: 'options', actorId: String(req.user._id) });
    const active = await Vehicle.find({ _id: { $in: vehicles.map(vehicle => vehicle.sourceVehicleId) }, status: activeVehicle })
      .select('_id vehicleId plateNumber type').sort('vehicleId').lean();
    const data = confirmedFleetVehicles(active, vehicles)
      .map(({ _id, vehicleId, plateNumber, type }) => ({ id: String(_id), label: vehicleId, plate: plateNumber, type }));
    return res.json({ data, currentDriverIds });
  } catch {
    return res.status(503).json({ message: 'Vehicle assignments are temporarily unavailable.' });
  }
});

async function checkRoster({ kind, pairs }, send, actorId) {
  const ending = kind === 'end';
  const driverIds = pairs.map(pair => pair.driverId);
  const drivers = User.countDocuments({ _id: { $in: driverIds }, role: 'driver', ...(!ending && { isActive: true }) });
  // End may close an inactive driver's custody. Reports checks the assignment
  // at the effective time during both review and the atomic first save.
  if (ending) return await drivers === driverIds.length;

  const vehicleIds = pairs.map(pair => pair.sourceVehicleId);
  const [driverCount, active, { vehicles }] = await Promise.all([
    drivers,
    Vehicle.find({ _id: { $in: vehicleIds }, status: activeVehicle }).select('_id type').lean(),
    send({ phase: 'options', actorId }),
  ]);
  return driverCount === driverIds.length && confirmedFleetVehicles(active, vehicles).length === vehicleIds.length;
}

router.post('/', async (req, res) => {
  try {
    const actorId = String(req.user._id);
    const data = await dispatchFleet(req.body ?? {}, {
      actorId, secret: process.env.MATTER_FLEET_LINK_SECRET,
      allowCorrection: process.env.MATTER_DISPATCH_FLEET_HISTORICAL_CORRECTIONS === '1'
        && ['super_admin', 'admin'].includes(req.user.role),
      checkRoster: command => checkRoster(command, req.sendFleetDispatch, actorId),
      send: req.sendFleetDispatch,
    });
    return res.json({ data });
  } catch (error) {
    if ([400, 403, 409, 422].includes(error.status)) return res.status(error.status).json({ message: error.message });
    return res.status(503).json({ message: 'Vehicle save could not be confirmed. Retry this same request.' });
  }
});

export default router;
