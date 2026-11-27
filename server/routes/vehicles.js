import express from 'express';
import Vehicle from '../models/Vehicle.js';
import FuelLog from '../models/FuelLog.js';
import { protect, admin } from '../middleware/auth.js';
import { driverSourceId, fleetRoster, legacyFleetConflict } from '../services/fleetDispatch.js';

const router = express.Router();

const DRIVER_SELECT = 'profile.firstName profile.lastName profile.phone';
const CREATOR_SELECT = 'profile.firstName profile.lastName';

/**
 * GET /api/vehicles
 * List vehicles with search/filter/pagination, plus fleet-wide stats for
 * the KPI cards (computed independently of the current page/filter so the
 * cards always reflect the whole fleet).
 */
router.get('/', protect, async (req, res) => {
  try {
    const { search, status, type, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status && status !== 'all') query.status = status;
    if (type && type !== 'all') query.type = type;
    if (search) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [{ vehicleId: regex }, { plateNumber: regex }];
    }

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [vehicles, total, allVehicles, fuelSpendAgg] = await Promise.all([
      Vehicle.find(query)
        .populate('assignedDriver', DRIVER_SELECT)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      Vehicle.countDocuments(query),
      Vehicle.find({}).select('status fuelLevel').lean(),
      FuelLog.aggregate([
        { $match: { date: { $gte: since30d } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    const totalVehicles = allVehicles.length;
    const inService = allVehicles.filter((v) => v.status === 'active').length;
    const maintenanceRequired = allVehicles.filter((v) => v.status === 'maintenance').length;
    const avgFuelLevel = totalVehicles > 0
      ? Math.round(allVehicles.reduce((sum, v) => sum + (v.fuelLevel ?? 0), 0) / totalVehicles)
      : 0;
    const fuelSpend30d = Math.round((fuelSpendAgg[0]?.total || 0) * 100) / 100;

    res.json({
      success: true,
      data: vehicles,
      stats: { totalVehicles, inService, maintenanceRequired, avgFuelLevel, fuelSpend30d },
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error('Get vehicles error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch vehicles' });
  }
});

// GET /api/vehicles/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id).populate('assignedDriver', DRIVER_SELECT);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }
    res.json({ success: true, data: vehicle });
  } catch (error) {
    console.error('Get vehicle error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch vehicle' });
  }
});

// POST /api/vehicles
router.post('/', protect, admin, async (req, res) => {
  try {
    const { vehicleId, type, plateNumber, assignedDriver, status, fuelLevel, notes } = req.body;

    if (!vehicleId || !type || !plateNumber) {
      return res.status(400).json({ success: false, message: 'vehicleId, type, and plateNumber are required' });
    }

    if (assignedDriver && fleetRoster()?.driverIds.has(driverSourceId(assignedDriver))) throw legacyFleetConflict();

    const vehicle = await Vehicle.create({
      vehicleId,
      type,
      plateNumber,
      assignedDriver: assignedDriver || null,
      status,
      fuelLevel,
      notes
    });

    const populated = await vehicle.populate('assignedDriver', DRIVER_SELECT);
    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'A vehicle with this Vehicle ID already exists' });
    }
    if ([409, 503].includes(error.status)) return res.status(error.status).json({ success: false, message: error.message });
    console.error('Create vehicle error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to create vehicle' });
  }
});

// PUT /api/vehicles/:id — also used to assign/unassign a driver and change status/fuel level
router.put('/:id', protect, admin, async (req, res) => {
  try {
    const { vehicleId, type, plateNumber, assignedDriver, status, fuelLevel, notes } = req.body;
    const update = {};
    if (vehicleId !== undefined) update.vehicleId = vehicleId;
    if (type !== undefined) update.type = type;
    if (plateNumber !== undefined) update.plateNumber = plateNumber;
    if (assignedDriver !== undefined) update.assignedDriver = assignedDriver || null;
    if (status !== undefined) update.status = status;
    if (fuelLevel !== undefined) update.fuelLevel = fuelLevel;
    if (notes !== undefined) update.notes = notes;

    const roster = assignedDriver !== undefined || type !== undefined ? fleetRoster() : null;
    if (roster) {
      const current = await Vehicle.findById(req.params.id).select('type assignedDriver').lean();
      if (!current) return res.status(404).json({ success: false, message: 'Vehicle not found' });
      const managed = roster.assets.has(String(current._id));
      const previousDriver = driverSourceId(current.assignedDriver);
      const requestedDriver = driverSourceId(assignedDriver);
      if (managed && type !== undefined) {
        if (type !== current.type) throw legacyFleetConflict();
        delete update.type;
      }
      if (assignedDriver !== undefined && (managed || roster.driverIds.has(previousDriver) || roster.driverIds.has(requestedDriver))) {
        if (requestedDriver !== previousDriver) throw legacyFleetConflict();
        // Generic Fleet edits also echo the driver field. Do not write it
        // back when Dispatch might already have committed a later handover.
        delete update.assignedDriver;
      }
    }

    const vehicle = await Vehicle.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .populate('assignedDriver', DRIVER_SELECT);

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }
    res.json({ success: true, data: vehicle });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'A vehicle with this Vehicle ID already exists' });
    }
    if ([409, 503].includes(error.status)) return res.status(error.status).json({ success: false, message: error.message });
    console.error('Update vehicle error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update vehicle' });
  }
});

// DELETE /api/vehicles/:id
router.delete('/:id', protect, admin, async (req, res) => {
  try {
    const roster = fleetRoster();
    if (roster) {
      const current = await Vehicle.findById(req.params.id).select('assignedDriver').lean();
      if (current && (roster.assets.has(String(current._id)) || roster.driverIds.has(driverSourceId(current.assignedDriver)))) {
        throw legacyFleetConflict();
      }
    }
    const vehicle = await Vehicle.findByIdAndDelete(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }
    // Clean up this vehicle's fuel history too.
    await FuelLog.deleteMany({ vehicle: req.params.id });
    res.json({ success: true, message: 'Vehicle removed' });
  } catch (error) {
    if ([409, 503].includes(error.status)) return res.status(error.status).json({ success: false, message: error.message });
    console.error('Delete vehicle error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete vehicle' });
  }
});

/**
 * GET /api/vehicles/:id/fuel-logs
 * Petrol expense history for one vehicle, newest first, plus a spend summary.
 */
router.get('/:id/fuel-logs', protect, async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id).select('_id vehicleId').lean();
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    const logs = await FuelLog.find({ vehicle: req.params.id })
      .populate('createdBy', CREATOR_SELECT)
      .sort({ date: -1, createdAt: -1 })
      .lean();

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const round2 = (n) => Math.round(n * 100) / 100;
    const summary = {
      count: logs.length,
      totalAmount: round2(logs.reduce((s, l) => s + (l.amount || 0), 0)),
      totalLiters: round2(logs.reduce((s, l) => s + (l.liters || 0), 0)),
      thisMonthAmount: round2(
        logs
          .filter((l) => new Date(l.date) >= startOfMonth)
          .reduce((s, l) => s + (l.amount || 0), 0)
      ),
      currency: logs[0]?.currency || 'AED'
    };

    res.json({ success: true, data: logs, summary });
  } catch (error) {
    console.error('Get fuel logs error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch fuel logs' });
  }
});

/**
 * POST /api/vehicles/:id/fuel-logs
 * Record a petrol expense for a vehicle.
 */
router.post('/:id/fuel-logs', protect, async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id).select('_id').lean();
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    const { amount, date, currency, liters, odometer, station, notes } = req.body;
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: 'A positive amount is required' });
    }

    const log = await FuelLog.create({
      vehicle: req.params.id,
      amount: numericAmount,
      date: date ? new Date(date) : new Date(),
      currency: currency || 'AED',
      liters: liters === '' || liters == null ? null : Number(liters),
      odometer: odometer === '' || odometer == null ? null : Number(odometer),
      station: station || undefined,
      notes: notes || undefined,
      createdBy: req.user?._id || null
    });

    const populated = await log.populate('createdBy', CREATOR_SELECT);
    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Create fuel log error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to log fuel expense' });
  }
});

/**
 * DELETE /api/vehicles/:id/fuel-logs/:logId
 */
router.delete('/:id/fuel-logs/:logId', protect, admin, async (req, res) => {
  try {
    const deleted = await FuelLog.findOneAndDelete({ _id: req.params.logId, vehicle: req.params.id });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Fuel log not found' });
    }
    res.json({ success: true, message: 'Fuel log removed' });
  } catch (error) {
    console.error('Delete fuel log error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete fuel log' });
  }
});

export default router;
