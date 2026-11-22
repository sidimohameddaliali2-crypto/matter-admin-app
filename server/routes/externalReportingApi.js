import express from 'express';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import { ABU_DHABI_ZONE } from '../config/zoneRules.js';
import { getBusinessDayBounds, isDateKey } from '../utils/businessDate.js';
import { apiKeyAuth, isReportingApiClient } from '../middleware/apiKeyAuth.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import VehicleLocationCaptureBatch from '../models/VehicleLocationCaptureBatch.js';
import { CAPTURE_MAX_ROWS, captureObservationId, captureTickId } from '../services/vehicleLocationCaptureStore.js';
import { CAPTURE_FIELDS, serializeHistoryPoint } from '../services/vehicleLocationView.js';
import { inspectReportingMongoTopology, readReportingChanges, readReportingWatermark, reportingCaptureEnabled } from '../services/reportingOutbox.js';

const router = express.Router();
router.use(apiKeyAuth);
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  if (!isReportingApiClient(req)) return res.status(403).json({ success: false, message: 'Reporting access is not enabled for this API client' });
  next();
});

router.get('/changes', async (req, res) => {
  try {
    const page = await readReportingChanges(req.query);
    res.json({ success: true, ...page });
  } catch (error) {
    const invalid = error.statusCode === 400;
    if (!invalid) console.error('Reporting changes are unavailable');
    res.status(invalid ? 400 : 503).json({ success: false, message: invalid ? error.message : 'Reporting changes are unavailable' });
  }
});

const maxDayRows = 5000;

router.get('/readiness', async (_req, res) => {
  try {
    const transaction = await inspectReportingMongoTopology();
    res.status(transaction.writable ? 200 : 503).json({
      success: transaction.writable,
      captureEnabled: reportingCaptureEnabled(),
      emitterEnabled: process.env.MATTER_REPORTING_EMITTER_ENABLED === '1',
      transaction,
    });
  } catch {
    res.status(503).json({ success: false, message: 'Reporting topology is unavailable' });
  }
});

router.get('/days/:day/ids', async (req, res) => {
  const day = req.params.day;
  if (!isDateKey(day)) return res.status(400).json({ success: false, message: 'Invalid Dubai service date' });
  const { startOfDay, endOfDayExclusive } = getBusinessDayBounds(day);
  try {
    // The watermark and membership are read from the same snapshot. The
    // ordinary delivery writes outside the outbox still change membership
    // or the source row's update clock and status.
    const result = await mongoose.connection.transaction(async session => {
      const through = await readReportingWatermark(session);
      const rows = await Delivery.find({
        scheduledTime: { $gte: startOfDay, $lt: endOfDayExclusive },
        $expr: { $ne: [
          { $toLower: { $trim: { input: { $convert: { input: '$zone', to: 'string', onNull: '', onError: '' } } } } },
          ABU_DHABI_ZONE.toLowerCase(),
        ] },
      }).session(session).select('_id status type updatedAt +reportingVersion')
        .sort({ scheduledTime: 1, _id: 1 }).limit(maxDayRows + 1).maxTimeMS(5_000).lean();
      if (rows.length > maxDayRows) return null;
      return { through, data: rows.map(row => ({
        id: String(row._id),
        status: typeof row.status === 'string' ? row.status.trim().toLowerCase() || null : null,
        type: typeof row.type === 'string' ? row.type.trim() || null : null,
        updatedAt: row.updatedAt instanceof Date && Number.isFinite(+row.updatedAt) ? row.updatedAt.toISOString() : null,
        reportingVersion: Number.isSafeInteger(row.reportingVersion) && row.reportingVersion > 0 ? row.reportingVersion : null,
      })) };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    if (!result) return res.status(413).json({ success: false, message: 'Dubai service day exceeds the reporting snapshot limit' });
    res.json({ success: true, day, ...result });
  } catch {
    console.error('Reporting day snapshot is unavailable');
    res.status(503).json({ success: false, message: 'Reporting day snapshot is unavailable' });
  }
});

router.get('/gps-batches/:id', async (req, res) => {
  const batchId = req.params.id;
  const tick = /^vehicle-location:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(batchId)?.[1];
  if (!tick || !Number.isFinite(Date.parse(tick)) || captureTickId(tick) !== batchId) {
    return res.status(400).json({ success: false, message: 'Invalid GPS batch id' });
  }
  try {
    // Only a fully acknowledged, immutable capture can be read via this endpoint.
    const [batch] = await VehicleLocationCaptureBatch.aggregate([
      { $match: { _id: batchId, state: 'complete' } },
      { $project: { count: { $size: '$payload.rows' } } },
    ]).read('primary').readConcern('majority');
    if (!batch) return res.status(404).json({ success: false, message: 'Completed GPS batch not found' });
    if (!Number.isSafeInteger(batch.count) || batch.count < 0 || batch.count > CAPTURE_MAX_ROWS) {
      throw new Error('Invalid committed GPS batch count');
    }
    const ids = Array.from({ length: batch.count }, (_, index) => captureObservationId(batchId, index));
    const rows = await VehicleLocationHistory.find({ _id: { $in: ids }, captureBatchId: batchId })
      .read('primary').readConcern('majority')
      .sort({ captureRow: 1 }).limit(CAPTURE_MAX_ROWS + 1)
      .select('vehicleNo driver latitude longitude gpsTime recordedAt ' + CAPTURE_FIELDS).lean();
    if (rows.length !== batch.count || rows.some((row, index) => row.captureRow !== index)) {
      throw new Error('Incomplete committed GPS batch');
    }
    res.json({ success: true, data: rows.map(serializeHistoryPoint), batchId });
  } catch {
    console.error('Reporting GPS batch is unavailable');
    res.status(503).json({ success: false, message: 'Reporting GPS batch is unavailable' });
  }
});

export default router;
