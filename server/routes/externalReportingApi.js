import express from 'express';
import mongoose from 'mongoose';
import Bag from '../models/Bag.js';
import DeliveryChange from '../models/DeliveryChange.js';
import { amendmentEvidence, amendmentReadLimit, bagAliasQuery, bagEvidence } from '../services/arrivalSourceEvidence.js';
import { bookingDeadlineEvidence } from '../services/matterBookingDeadline.js';
import Delivery from '../models/Delivery.js';
import { ABU_DHABI_ZONE } from '../config/zoneRules.js';
import { getBusinessDayBounds, isDateKey, toBusinessDateKey } from '../utils/businessDate.js';
import { apiKeyAuth, isReportingApiClient } from '../middleware/apiKeyAuth.js';
import { createReportingVercelIdentity, isReportingVercelRead } from '../middleware/reportingVercelIdentity.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import VehicleLocationCaptureBatch from '../models/VehicleLocationCaptureBatch.js';
import { CAPTURE_MAX_ROWS, captureObservationId, captureTickId } from '../services/vehicleLocationCaptureStore.js';
import { CAPTURE_FIELDS, serializeHistoryPoint } from '../services/vehicleLocationView.js';
import { inspectReportingMongoTopology, readReportingChanges, readReportingWatermark, reportingCaptureEnabled } from '../services/reportingOutbox.js';
import { serializeDelivery } from './externalDeliveryApi.js';
import { fleetProofForReporting } from '../services/fleetProofReceipt.js';
import { readFleetAssignmentReceipt } from '../services/fleetDispatchStore.js';

const router = express.Router();
const hasReportingVercelIdentity = createReportingVercelIdentity();

router.use(async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  if (isReportingVercelRead(req)) {
    if (!await hasReportingVercelIdentity(req)) {
      return res.status(401).json({ success: false, message: 'Invalid reporting identity' });
    }
    return next();
  }
  return apiKeyAuth(req, res, () => {
    if (!isReportingApiClient(req)) {
      return res.status(403).json({ success: false, message: 'Reporting access is not enabled for this API client' });
    }
    return next();
  });
});

const reportingAddressFields = [
  'label', 'city', 'area', 'street', 'sourceCategory', 'building', 'floor',
  'apartment', 'unit', 'addressStatus', 'locationType',
];

export function serializeReportingDelivery(delivery) {
  const summary = {
    id: String(delivery._id),
    reportingVersion: delivery.reportingVersion,
    scheduledTime: delivery.scheduledTime,
    zone: delivery.zone ?? null,
  };
  if (typeof summary.zone === 'string' && summary.zone.trim().toLowerCase() === ABU_DHABI_ZONE.toLowerCase()) {
    // Keep the source revision so a previously published delivery can be removed.
    return summary;
  }
  const data = serializeDelivery(delivery, undefined, { includeProofEvidence: true });
  const { customerName, customerId, company, type, status, address, addressId, addressDetails,
    matterSubscriptionId, locationType, deliveredTime, timing, driver, proof, gpsLocation, updatedAt } = data;
  const fleetProof = fleetProofForReporting(delivery.fleetProofReceipt, proof);
  return {
    ...summary, customerName, customerId, company, type, status, address, addressId,
    matterSubscriptionId, locationType, deliveredTime, timing, updatedAt,
    addressDetails: addressDetails
      ? Object.fromEntries(reportingAddressFields.map(field => [field, addressDetails[field] ?? null])) : null,
    driver: driver ? { id: driver.id, name: driver.name, vehicleType: driver.vehicleType } : null,
    proof: {
      photoUrl: proof.photoUrl,
      timestamp: proof.timestamp,
      receivedAt: proof.receivedAt,
      photoCapturedAt: proof.photoCapturedAt,
      ...(proof.photoSource && { photoSource: proof.photoSource }),
      location: proof.location,
    },
    ...(fleetProof && { fleetProof }),
    gpsLocation: gpsLocation ? { lat: gpsLocation.lat, lng: gpsLocation.lng } : null,
  };
}

// Return bounded coverage for this allocation even after years of bag reuse.
// Retain malformed or unclocked deliver rows conservatively. The native bag
// history remains unmodified, including movements omitted from this projection.
async function readRelevantBags(aliases, orderId, session) {
  const ownEventIds = aliases.map(label => 'delivery:' + orderId + ':deliver:' + label);
  const isOwn = {$or:[{$eq:['$$h.deliveryId',new mongoose.Types.ObjectId(String(orderId))]},{$in:['$$h.eventId',ownEventIds]}]};
  const clock = field => ({$convert:{input:field,to:'date',onNull:null,onError:null}});
  const close = (a,b) => ({$let:{vars:{a:clock(a),b:clock(b)},in:{$and:[{$ne:['$$a',null]},{$ne:['$$b',null]},
    {$lte:[{$abs:{$subtract:['$$a','$$b']}},5*60*1000]}]}}});
  const device = ['occurredAt','scannedAt'];
  const near = {$or:[close('$$h.timestamp','$$own.timestamp'),...device.flatMap(a => device.map(b => close('$$h.'+a,'$$own.'+b)))]};
  return Bag.aggregate([
    {$match:{bagId:{$in:aliases}}},
    {$limit:65},
    {$set:{own:{$filter:{input:{$ifNull:['$history',[]]},as:'h',cond:isOwn}}}},
    {$set:{history:{$slice:[{$filter:{input:{$ifNull:['$history',[]]},as:'h',cond:{$and:[
      {$eq:['$$h.eventType','deliver']},{$or:[isOwn,{$eq:[clock('$$h.occurredAt'),null]},{$eq:[clock('$$h.timestamp'),null]},
        {$anyElementTrue:[{$map:{input:'$own',as:'own',in:near}}]}]},
    ]}}},513]}}},
    {$project:{bagId:1,history:{$map:{input:'$history',as:'h',in:{
      eventType:'$$h.eventType',eventId:'$$h.eventId',deliveryId:'$$h.deliveryId',
      physicalScan:'$$h.physicalScan',acquisition:'$$h.acquisition',scannedAt:'$$h.scannedAt',
      occurredAt:'$$h.occurredAt',timestamp:'$$h.timestamp',assignedBy:{user:'$$h.assignedBy.user'},
      assignedTo:{driver:'$$h.assignedTo.driver',customer:{customerId:'$$h.assignedTo.customer.customerId'}},
    }}}}},
  ]).session(session).option({maxTimeMS:5000});
}

export async function readReportingDeliverySnapshot(orderId) {
  let data;
  const readSnapshot = async session => {
    const query = Delivery.findById(orderId).read('primary');
    if (session) query.session(session);
    else query.readConcern('majority');
    const delivery = await query
      .select('customerId customerName company otherCompany type status address addressId addressDetails zone matterSubscriptionId matterCustomerId scheduledTime deliveredTime completedAt deliveryType lateMinutes earlyMinutes driver proof.photoUrl proof.images proof.timestamp proof.receivedAt proof.photoCapturedAt proof.photoSource proof.location proof.bagIds proof.bagId proof.qrSkipped gpsLocation updatedAt +reportingVersion +fleetProofReceipt +matterBookingObservations')
      .populate({path:'driver',select:'profile.firstName profile.lastName profile.vehicleType',options:{session}}).maxTimeMS(5000).lean();
    if (!Number.isSafeInteger(delivery?.reportingVersion) || delivery.reportingVersion < 1) { data = null; return; }
    data = serializeReportingDelivery(delivery);
    // Keep the existing restricted zone summary and non-delivery responses.
    if (data.type !== 'Delivery' || !session) return;
    const serviceDate = toBusinessDateKey(delivery.scheduledTime);
    const aliases = bagAliasQuery(delivery);
    const inventory = aliases.length ? await readRelevantBags(aliases, orderId, session) : [];
    const bags = bagEvidence(delivery,inventory);
    if (inventory.length === 65) bags.state = 'partial';
    if (bags.peerEvents.length) {
      // Excluded or missing peers prevent attribution. Leave their private
      // records outside the reporting response.
      const peers = await Delivery.find({_id:{$in:bags.peerEvents.map(row => row.orderId)}})
        .session(session).select('zone').maxTimeMS(5000).lean();
      const eligible = new Set(peers.filter(row => String(row.zone ?? '').trim().toLowerCase() !== ABU_DHABI_ZONE.toLowerCase()).map(row => String(row._id)));
      if (bags.peerEvents.some(row => !eligible.has(row.orderId))) {
        bags.state = 'partial';
        bags.peerEvents = bags.peerEvents.filter(row => eligible.has(row.orderId));
      }
    }
    const bounds = getBusinessDayBounds(serviceDate);
    const changes = await DeliveryChange.find({status:'applied',$or:[
      {appliedToDelivery:delivery._id}, {appliedOrderIds:delivery._id},
      // Older same-day bulk edits named only the first affected order.
      {appliedOrderIds:{$exists:false},customerId:delivery.customerId,
        scheduledDate:{$gte:bounds.startOfDay,$lt:bounds.endOfDayExclusive}},
    ]})
      .session(session).select('appliedToDelivery +appliedOrderIds scheduledDate customerId status appliedAt changes')
      .sort({appliedAt:1,_id:1}).limit(amendmentReadLimit).maxTimeMS(5000).lean();
    data.arrivalEvidence = {version:1,orderId:data.id,serviceDate,customerId:String(data.customerId ?? ''),
      subscriptionId:data.matterSubscriptionId == null ? null : String(data.matterSubscriptionId),
      addressId:data.addressId == null ? null : String(data.addressId),
      booking:bookingDeadlineEvidence(delivery), amendments:amendmentEvidence(delivery,changes), bags};
  };
  // Disarming transactional capture preserves the old single-document
  // majority read. Supplemental rows could have changed without a version.
  if (reportingCaptureEnabled()) {
    await mongoose.connection.transaction(readSnapshot, {readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
  } else await readSnapshot(null);
  return data;
}

router.get('/deliveries/:id', async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid delivery id' });
  }
  try {
    const data = await readReportingDeliverySnapshot(req.params.id);
    if (!data) return res.status(404).json({success:false,message:'Versioned reporting delivery not found'});
    return res.json({success:true,data});
  } catch {
    console.error('Reporting delivery snapshot is unavailable');
    return res.status(503).json({ success: false, message: 'Reporting delivery snapshot is unavailable' });
  }
});

router.get('/fleet-assignments/:id', async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid vehicle assignment receipt id' });
  }
  if (!reportingCaptureEnabled()) {
    return res.status(503).json({ success: false, message: 'Reporting capture is unavailable' });
  }
  try {
    const data = await readFleetAssignmentReceipt(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: 'Vehicle assignment receipt not found' });
    return res.json({ success: true, data });
  } catch {
    return res.status(503).json({ success: false, message: 'Vehicle assignment receipt is unavailable' });
  }
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

const maxDayRows = 2000;

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
    // Mongoose 7 returns the commit receipt, so keep the final attempt's rows
    // here and use them only once the snapshot transaction has committed.
    let result;
    await mongoose.connection.transaction(async session => {
      const through = await readReportingWatermark(session);
      const rows = await Delivery.find({
        scheduledTime: { $gte: startOfDay, $lt: endOfDayExclusive },
        $expr: { $ne: [
          { $toLower: { $trim: { input: { $convert: { input: '$zone', to: 'string', onNull: '', onError: '' } } } } },
          ABU_DHABI_ZONE.toLowerCase(),
        ] },
      }).session(session).select('_id status type updatedAt +reportingVersion')
        .sort({ scheduledTime: 1, _id: 1 }).limit(maxDayRows + 1).maxTimeMS(5_000).lean();
      result = rows.length > maxDayRows ? null : { through, data: rows.map(row => ({
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
      .select('vehicleNo driver latitude longitude gpsTime recordedAt trackerIdentity ' + CAPTURE_FIELDS).lean();
    if (rows.length !== batch.count || rows.some((row, index) => row.captureRow !== index)) {
      throw new Error('Incomplete committed GPS batch');
    }
    res.json({ success: true, data: rows.map(row => serializeHistoryPoint(row, { includeTrackerIdentity: true })), batchId });
  } catch {
    console.error('Reporting GPS batch is unavailable');
    res.status(503).json({ success: false, message: 'Reporting GPS batch is unavailable' });
  }
});

export default router;
