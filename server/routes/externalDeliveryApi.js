import express from 'express';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import { isDateKey, businessDayStart } from '../utils/businessDate.js';

// Read-only delivery API for external/third-party consumers (logistics
// partners, kitchen systems, etc.) — authenticated with a static API key
// (see middleware/apiKeyAuth.js), not the app's own JWT login.
//
// Every delivery in the response carries the assigned driver's details and
// the customer's current meal count (Customer.mealPerDay), so a consumer
// never has to make a second call to look either up.

const router = express.Router();

router.use(apiKeyAuth);

const MAX_LIMIT = 200;

// Same business-day convention as the rest of the app (utils/businessDate.js)
// so "give me the 11th" matches the business day drivers actually see, not a
// UTC slice of it.
const DAY_MS = 24 * 60 * 60 * 1000;

// Turns a `date`/`dateFrom`/`dateTo` query value into a real Date.
// - A bare "YYYY-MM-DD" is treated as a LOCAL calendar day: `endOfDay`
//   picks whether it becomes that day's 00:00:00.000 or 23:59:59.999.
//   This is what makes `?date=2026-09-11` or
//   `?dateFrom=2026-09-01&dateTo=2026-09-07` return every delivery
//   scheduled anywhere in those local days, not just ones at exact UTC
//   midnight.
// - Anything else (a full ISO datetime) is parsed as-is, so a caller who
//   wants exact instant boundaries can still get them.
// Returns null for an unparseable value.
function parseDateBoundary(value, endOfDay) {
  if (!value) return null;
  if (isDateKey(value)) {
    const start = businessDayStart(value);
    return endOfDay ? new Date(start.getTime() + DAY_MS - 1) : start;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function driverPayload(driver) {
  if (!driver || typeof driver === 'string') return null;
  const firstName = driver.profile?.firstName || '';
  const lastName = driver.profile?.lastName || '';
  return {
    id: String(driver._id),
    name: [firstName, lastName].filter(Boolean).join(' ') || driver.email || null,
    phone: driver.profile?.phone || null,
    vehicleType: driver.profile?.vehicleType || null,
    email: driver.email || null,
  };
}

// early / on-time / late, recomputed from the two timestamps (3-hour early
// threshold) so it's correct even when lateMinutes/earlyMinutes/deliveryType
// were never persisted — same rule used across the app (see
// enrichDeliveryTiming in routes/deliveries.js).
function timingFor(delivery) {
  const scheduled = delivery.scheduledTime ? new Date(delivery.scheduledTime) : null;
  const delivered = delivery.deliveredTime ? new Date(delivery.deliveredTime) : null;
  if (!scheduled || !delivered || Number.isNaN(scheduled.getTime()) || Number.isNaN(delivered.getTime())) {
    return {
      status: delivery.deliveryType || null,
      lateMinutes: delivery.lateMinutes || 0,
      earlyMinutes: delivery.earlyMinutes || 0,
    };
  }
  const diffMinutes = Math.round((delivered - scheduled) / 60000);
  const earlyThreshold = new Date(scheduled.getTime() - 180 * 60000);
  const lateMinutes = diffMinutes > 0 ? diffMinutes : 0;
  const earlyMinutes = delivered < earlyThreshold
    ? Math.max(0, Math.round((earlyThreshold - delivered) / 60000))
    : 0;
  return {
    status: lateMinutes > 0 ? 'late' : earlyMinutes > 0 ? 'early' : 'on-time',
    lateMinutes,
    earlyMinutes,
  };
}

// `customersById` is a Map keyed by Customer.customerId (delivery.customerId
// is the same string, not a Mongo ref) — pass it pre-fetched so a list
// endpoint doesn't do one Customer lookup per delivery.
function serializeDelivery(delivery, customersById) {
  const d = typeof delivery.toObject === 'function' ? delivery.toObject() : delivery;
  const t = timingFor(d);
  const proof = d.proof || {};
  const customer = customersById?.get(String(d.customerId)) || null;

  return {
    id: String(d._id),
    customerId: d.customerId || null,
    customerName: d.customerName || null,
    company: d.company === 'Other' && d.otherCompany ? d.otherCompany : (d.company || null),
    type: d.type || 'Delivery',
    address: d.address || null,
    locationType: d.addressDetails?.locationType || null,
    zone: d.zone || null,
    addressId: d.addressId || null,
    scheduledTime: d.scheduledTime || null,
    status: d.status || null,
    deliveredTime: d.deliveredTime || d.completedAt || null,
    timing: {
      status: t.status,
      lateMinutes: t.lateMinutes,
      earlyMinutes: t.earlyMinutes,
    },
    driver: driverPayload(d.driver),
    proof: {
      photoUrl: proof.photoUrl || (Array.isArray(proof.images) && proof.images[0]) || null,
      notes: proof.notes || null,
      timestamp: proof.timestamp || null,
    },
    gpsLocation: d.gpsLocation?.lat != null && d.gpsLocation?.lng != null
      ? { lat: d.gpsLocation.lat, lng: d.gpsLocation.lng, link: d.gpsLocation.link || null }
      : null,
    // The customer's own details, grouped together — name, this delivery's
    // timing/zone/address/GPS from the customer's point of view, and
    // location type (Villa/Apartment), plus meal count/plan. Owner,
    // 2026-09-23: "include the customer name, customer timing, customer
    // zone, customer address, customer gps location, and Location Type."
    // The same values already exist as flat top-level fields above (kept
    // as-is — an existing consumer may already read them there); this is
    // purely additive, not a breaking rename.
    customer: {
      customerId: d.customerId || null,
      name: d.customerName || null,
      timing: d.scheduledTime || null,
      zone: d.zone || null,
      address: d.address || null,
      gpsLocation: d.gpsLocation?.lat != null && d.gpsLocation?.lng != null
        ? { lat: d.gpsLocation.lat, lng: d.gpsLocation.lng, link: d.gpsLocation.link || null }
        : null,
      locationType: d.addressDetails?.locationType || null,
      mealPerDay: customer?.mealPerDay ?? null,
      mealPlan: customer?.mealPlan ?? null,
    },
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  };
}

async function fetchCustomersFor(deliveries) {
  const ids = Array.from(new Set(deliveries.map((d) => d.customerId).filter(Boolean)));
  if (ids.length === 0) return new Map();
  const customers = await Customer.find({ customerId: { $in: ids } })
    .select('customerId mealPerDay mealPlan')
    .lean();
  return new Map(customers.map((c) => [String(c.customerId), c]));
}

// @desc    List deliveries (with driver + customer meal count) for an
//          external consumer.
// @route   GET /api/external/deliveries
// @query   date (single day, YYYY-MM-DD) — OR dateFrom/dateTo (range, each
//          YYYY-MM-DD or full ISO) — filtered on scheduledTime; status,
//          driverId, customerId, updatedSince (ISO — deliveries touched
//          since then), page, limit (max 200)
router.get('/', async (req, res) => {
  try {
    const { date, dateFrom, dateTo, status, driverId, customerId, updatedSince, page = 1, limit = 50 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (customerId) query.customerId = customerId;
    if (driverId) {
      if (!mongoose.Types.ObjectId.isValid(driverId)) {
        return res.status(400).json({ success: false, message: 'Invalid driverId' });
      }
      query.driver = driverId;
    }

    // `date` is the single-day shortcut ("give me the 11th"); `dateFrom`/
    // `dateTo` cover a range. Both accept either a bare YYYY-MM-DD (expanded
    // to that local day/range) or a full ISO datetime for exact bounds.
    if (date) {
      const start = parseDateBoundary(date, false);
      const end = parseDateBoundary(date, true);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD.' });
      }
      query.scheduledTime = { $gte: start, $lte: end };
    } else if (dateFrom || dateTo) {
      query.scheduledTime = {};
      if (dateFrom) {
        const from = parseDateBoundary(dateFrom, false);
        if (!from) return res.status(400).json({ success: false, message: 'Invalid dateFrom' });
        query.scheduledTime.$gte = from;
      }
      if (dateTo) {
        const to = parseDateBoundary(dateTo, true);
        if (!to) return res.status(400).json({ success: false, message: 'Invalid dateTo' });
        query.scheduledTime.$lte = to;
      }
    }

    if (updatedSince) {
      const since = new Date(updatedSince);
      if (Number.isNaN(since.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid updatedSince' });
      }
      query.updatedAt = { $gte: since };
    }

    const parsedPage = Number.parseInt(page, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    const safePage = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const safeLimit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 50 : Math.min(parsedLimit, MAX_LIMIT);

    const [deliveries, total] = await Promise.all([
      Delivery.find(query)
        .populate('driver', 'profile.firstName profile.lastName profile.phone profile.vehicleType email')
        .sort({ scheduledTime: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      Delivery.countDocuments(query),
    ]);

    const customersById = await fetchCustomersFor(deliveries);

    res.json({
      success: true,
      data: deliveries.map((d) => serializeDelivery(d, customersById)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    console.error('External delivery API list error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @desc    Get one delivery (with driver + customer meal count).
// @route   GET /api/external/deliveries/:id
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid delivery id' });
    }

    const delivery = await Delivery.findById(req.params.id)
      .populate('driver', 'profile.firstName profile.lastName profile.phone profile.vehicleType email')
      .lean();

    if (!delivery) {
      return res.status(404).json({ success: false, message: 'Delivery not found' });
    }

    const customersById = await fetchCustomersFor([delivery]);

    res.json({ success: true, data: serializeDelivery(delivery, customersById) });
  } catch (error) {
    console.error('External delivery API get-by-id error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
