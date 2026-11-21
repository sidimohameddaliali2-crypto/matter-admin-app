import express from 'express';
import { protect } from '../middleware/auth.js';
import { captureIngestionEnabled, ingestDriverCaptureBatch, CaptureRequestError } from '../services/driverCaptureEvents.js';
import { ingestDriverCapturePhoto, MAX_CAPTURE_PHOTO_BYTES } from '../services/driverCapturePhotos.js';

let modelReady;
async function ledgerModel() {
  if (!modelReady) {
    modelReady = import('../models/DriverCaptureEvent.js').then(async ({ default: Model }) => {
      await Model.init();
      // autoIndex can be disabled by deployment settings. Explicitly ensure
      // the unique identity index before any acceptance, only behind the gate.
      await Model.createIndexes();
      return Model;
    }).catch(error => { modelReady = null; throw error; });
  }
  return modelReady;
}

const repository = {
  async findEvent(key) {
    const Model = await ledgerModel();
    return Model.findOne(key).select('payloadHash originalEvent').read('primary').readConcern('majority').lean();
  },
  async findPhoto(key) {
    const Model = await photoModel();
    return Model.findOne(key).select('eventId contentSha256 ledgerPayloadHash').read('primary').readConcern('majority').lean();
  },
  async ownsDelivery({ accountId, deliveryId }) {
    if (!/^[a-f0-9]{24}$/i.test(deliveryId)) return false;
    const { default: Delivery } = await import('../models/Delivery.js');
    return Boolean(await Delivery.exists({ _id: deliveryId, driver: accountId }));
  },
  async acceptPhoto(record) {
    const Model = await photoModel();
    const key = { accountId: record.accountId, photoId: record.photoId };
    let duplicate = false;
    try {
      const result = await Model.updateOne(key, { $setOnInsert: record }, {
        upsert: true, writeConcern: { w: 'majority', j: true, wtimeout: 10000 }, runValidators: true });
      if (!result.acknowledged) throw new Error('Photo write not acknowledged');
      duplicate = result.upsertedCount === 0;
    } catch (error) { if (error?.code !== 11000) throw error; duplicate = true; }
    const stored = await this.findPhoto(key);
    if (!stored) throw new Error('Photo read-back unavailable');
    return { ...stored, duplicate };
  },
  async accept(record) {
    const Model = await ledgerModel();
    const key = { accountId: record.accountId, eventId: record.eventId };
    let duplicate = false;
    try {
      const result = await Model.updateOne(key, { $setOnInsert: {
        ...key, payloadHash: record.payloadHash, originalEvent: record.event,
        serverReceivedAt: new Date(record.serverReceivedAt), serverRecordedAt: new Date(),
        ledgerOnly: true, associationVerified: false,
      } }, { upsert: true, writeConcern: { w: 'majority', j: true, wtimeout: 10000 }, runValidators: true });
      if (!result.acknowledged) throw new Error('Ledger write not acknowledged');
      duplicate = result.upsertedCount === 0;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      duplicate = true; // Concurrent insert of the same stable identity.
    }
    const stored = await Model.findOne(key).select('payloadHash').read('primary').readConcern('majority').lean();
    if (!stored) throw new Error('Ledger read-back unavailable');
    return { payloadHash: stored.payloadHash, duplicate };
  },
};
let photoReady;
async function photoModel() {
  if (!photoReady) photoReady = import('../models/DriverCapturePhoto.js').then(async ({ default: Model }) => {
    await Model.init(); await Model.createIndexes(); return Model;
  }).catch(error => { photoReady = null; throw error; });
  return photoReady;
}

// Default-off gate runs before authentication and never initializes a model/index.
export function createDriverEventsRouter({ store = repository, authenticate = protect, enabled = captureIngestionEnabled } = {}) {
const router = express.Router();
router.use((req, res, next) => enabled()
  ? next() : res.status(404).json({ success: false, message: 'Not found' }));
router.use(authenticate);
router.use((req, res, next) => req.user?.role === 'driver' ? next() : res.status(403).json({ success: false, message: 'Driver account required' }));
router.post('/batch', express.json({ limit: '64kb', strict: true }), async (req, res) => {
  try {
    const result = await ingestDriverCaptureBatch({
      actor: { id: String(req.user._id), role: req.user.role }, body: req.body, repository: store,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof CaptureRequestError) return res.status(error.status).json({ success: false, message: error.message });
    res.status(503).json({ success: false, message: 'Capture ledger unavailable; retain events and retry.' });
  }
});
router.put('/photos/:photoId', express.raw({ type: 'image/jpeg', limit: MAX_CAPTURE_PHOTO_BYTES }), async (req, res) => {
  try {
    const result = await ingestDriverCapturePhoto({ actor: { id: String(req.user._id), role: req.user.role },
      photoId: req.params.photoId, eventId: req.get('X-Capture-Event-Id'), contentMd5: req.get('X-Content-MD5'), bytes: req.body, repository: store });
    res.json(result);
  } catch (error) {
    if (error instanceof CaptureRequestError) return res.status(error.status).json({ success: false, message: error.message });
    res.status(503).json({ success: false, message: 'Photo evidence unavailable; retain original and retry.' });
  }
});
return router;
}
export default createDriverEventsRouter();
