import mongoose from 'mongoose';
import { applyZoneRules, isAbuDhabiEmirate, ABU_DHABI_ZONE } from '../config/zoneRules.js';

const deliverySchema = new mongoose.Schema({
  
  customerId: {
    type: String,
    required: true
  },
  customerName: {
    type: String,
    required: true
  },
  // Set when this delivery was auto-imported from the real Matter
  // subscription platform (services/matterDeliveryImportService.js,
  // jobs/importMatterDeliveries.js) — the Matter subscription_id it came
  // from, as a string (matches Customer.matterSubscriptionId's type). Null
  // for every manually-entered/CSV-imported delivery, i.e. almost all
  // existing rows.
  matterSubscriptionId: {
    type: String,
    default: null,
    index: true
  },
  matterSource: { fetchedAt: Date, updatedAt: String, effectiveState: String, pinSource: String },
  // Matter's own id for the saved address this delivery goes to
  // (customer_addresses[].id, as a string) — a stable identity for "this
  // place", unlike customerId (a customer can have several addresses) or the
  // free-text `address`. Pin corrections only propagate between deliveries
  // that share it (see POST /:id/manual-coords). Null for manual/CSV
  // deliveries and for rows created before this field existed — those never
  // match anything. Cleared automatically if the address text is edited (see
  // the hooks below), since the id no longer describes the new text.
  addressId: {
    type: String,
    default: null
  },
  // Change scheduledTime to be within the delivery window
  scheduledTime: {
    type: Date,
    required: true
  },
  deliveredTime: Date,
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null
  },
  // Position of this delivery within the assigned driver's route for the
  // day, as computed by the route optimizer (server/optimizer/solve_routes.py).
  // Null means no route has been computed for this delivery yet — driver
  // lists fall back to sorting by scheduledTime in that case.
  routeOrder: {
    type: Number,
    default: null
  },
  routeOptimizedAt: {
    type: Date,
    default: null
  },
  // Set on a bike's second-trip deliveries: the van↔bike meeting where the
  // bike collects them. Null for everything else.
  handoff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Handoff',
    default: null
  },
  company: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
    default: 'Matter'
  },
  otherCompany: String,
  type: {
    type: String,
    enum: ['Delivery', 'Task', 'Collection'],
    default: 'Delivery'
  },
  taskType: {
    type: String,
    enum: ['Bag Collection', 'Purchase', 'Inspection'],
    required: false
  },
  address: String,
  addressDetails: {
    // The saved address's own label from the source system (e.g. Matter's
    // "Home"/"Work") — distinct from locationType below, which is Villa vs
    // Apartment.
    label: String,
    city: String,
    area: String,
    street: String,
    additionalDetails: String,
    sourceCategory: String,
    building: String,
    floor: String,
    apartment: String,
    // This saved address's own status at the source (e.g. Matter's
    // "active"/"inactive" for that customer_address entry) — distinct from
    // the delivery's own top-level `status` (pending/assigned/delivered/...).
    addressStatus: String,
    // Category of the delivery location, settable from the bulk import sheet
    // (a "Location Type" column, or a batch-wide default) and from manual entry.
    locationType: {
      type: String,
      // Must explicitly include null — its own default value — or Mongoose's
      // enum validator rejects it on full-document validation (re-saving ANY
      // existing delivery that still has the default, which is ~all of them,
      // e.g. via the manual pin-correction endpoint's delivery.save()).
      enum: ['Villa', 'Apartment', null],
      default: null
    }
  },
  notes: String,
  zone: {
    type: String,
    required: false
  },
  gpsLocation: {
    lat: Number,
    lng: Number,
    link: String
  },
   bagAssignment: {
    bagId: {
      type: String,
      required: false
    },
    assignedAt: {
      type: Date,
      required: false
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false
    },
    returnedAt: {
      type: Date,
      required: false
    },
    status: {
      type: String,
      enum: ['assigned', 'delivered', 'returned'],
      default: 'assigned'
    }
  },
  // Set when a customer-facing field (address, schedule, notes, pin, etc.)
  // is edited AFTER a driver was already assigned, so the driver app can
  // surface a "this changed since you were assigned" banner. Cleared when
  // the assigned driver explicitly acknowledges it.
  changeFlag: {
    active: { type: Boolean, default: false },
    changedAt: Date,
    changedFields: [String],
    note: String,
    acknowledgedAt: Date,
    acknowledgedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  status: {
    type: String,
    enum: ['pending', 'assigned', 'on_route', 'picked_up', 'delivered', 'failed', 'completed', 'collected'],
    default: 'pending'
  },
  collectionDetails: {
    bagIds: [String],
    collectedAt: Date,
    collectedPhotoUrl: String,
    noBagsAvailable: {
      type: Boolean,
      default: false
    }
  },
  completedAt: Date,
  lateMinutes: {
    type: Number,
    default: 0
  },
  earlyMinutes: {
  type: Number,
  default: 0
},
deliveryType: {
  type: String,
  enum: ['early', 'on-time', 'late'],
  default: 'on-time'
},
   proof: {
    images: [String], // This should store URLs, not base64
    photoUrl: String, // Primary photo URL (kept in sync with images[0])
    signature: String,
    bagId: String,
    timestamp: Date,
    location: {
      lat: Number,
      lng: Number,
      address: String
    },
    notes: String,
    verified: Boolean,
    deliveryMethod: String
  },
    
  timeline: [{
    status: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    notes: String
  }],
  complaint: {
    hasComplaint: { type: Boolean, default: false },
    details: String,
    complaintType: String,
    remarks: String,
    resolved: { type: Boolean, default: false },
    reportedAt: { type: Date },
    compensation: {
      type: { type: String, enum: ['refund', 'extra_day'], required: false },
      amount: { type: Number, required: false },
      days: { type: Number, required: false }
    }
  },
  
}, {
  timestamps: true
});

// Index for better query performance
deliverySchema.index({ scheduledTime: 1 });
deliverySchema.index({ driver: 1, status: 1 });
deliverySchema.index({ customerId: 1 });
deliverySchema.index({ driver: 1, scheduledTime: 1 }); // For getDriverTodaysDeliveries query
deliverySchema.index({ company: 1, zone: 1 }); // For bulk filtering by company/zone
deliverySchema.index({ status: 1, scheduledTime: 1 }); // For status queries with time range
deliverySchema.index({ driver: 1, type: 1 }); // For per-driver all-time stats (GET /api/users/drivers)
deliverySchema.index({ customerId: 1, addressId: 1, scheduledTime: 1 }); // Pin-correction propagation (same customer + address id, future jobs)

// Editing a delivery's address text makes its addressId stale — it would still
// point at the old saved address. Drop the id unless the same write sets one.
deliverySchema.pre('save', function clearStaleAddressIdOnSave(next) {
  if (!this.isNew && this.isModified('address') && !this.isModified('addressId')) {
    this.addressId = null;
  }
  next();
});

deliverySchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function clearStaleAddressIdOnUpdate(next) {
  // Only the `{ $set: {...} }` form — every address write in this codebase
  // (applyChangesToDelivery etc.) uses it.
  const update = this.getUpdate();
  const set = update && update.$set;
  if (set && Object.prototype.hasOwnProperty.call(set, 'address') && !Object.prototype.hasOwnProperty.call(set, 'addressId')) {
    set.addressId = null;
  }
  next();
});

// Automatic zone rules (config/zoneRules.js): emirate Abu Dhabi, or zone
// "Dubai South", -> zone "Abu Dhabi". Enforced here so it holds on every path:
// create / bulk insert / save all run 'validate'; the update hook covers
// findByIdAndUpdate-style edits (applyChangesToDelivery, dispatcher edits).
deliverySchema.pre('validate', function applyZoneRulesOnValidate(next) {
  const zone = applyZoneRules({ zone: this.zone, city: this.addressDetails?.city });
  if (zone !== this.zone) this.zone = zone;
  next();
});

deliverySchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], async function applyZoneRulesOnUpdate() {
  const update = this.getUpdate();
  const set = update && update.$set;
  if (!set) return;

  const cityInUpdate = set['addressDetails.city'] ?? set.addressDetails?.city;
  const touchesZone = Object.prototype.hasOwnProperty.call(set, 'zone');
  if (!touchesZone && cityInUpdate === undefined) return;

  // The emirate being set now, else (single-document edits only) the one on file.
  let city = cityInUpdate;
  if (city === undefined && this.op !== 'updateMany') {
    const existing = await this.model.findOne(this.getQuery()).select('addressDetails.city').lean();
    city = existing?.addressDetails?.city;
  }

  if (touchesZone) {
    set.zone = applyZoneRules({ zone: set.zone, city });
  } else if (isAbuDhabiEmirate(city)) {
    set.zone = ABU_DHABI_ZONE; // emirate changed to Abu Dhabi without a zone in the same edit
  }
});

deliverySchema.methods.updateStatus = async function (status, notes, location) {
  this.status = status;

  if (status === 'delivered') {
    this.deliveredTime = new Date();
  }

  const parsedLocation =
    typeof location === 'string'
      ? (() => {
          try {
            return JSON.parse(location);
          } catch (error) {
            return null;
          }
        })()
      : location;

  this.timeline.push({
    status,
    notes,
    timestamp: new Date(),
  });

  if (parsedLocation && typeof parsedLocation === 'object') {
    this.gpsLocation = {
      lat: parsedLocation.latitude ?? parsedLocation.lat ?? null,
      lng: parsedLocation.longitude ?? parsedLocation.lng ?? null,
      link: parsedLocation.link ?? this.gpsLocation?.link ?? null,
    };
  }

  return this.save();
};

deliverySchema.statics.getDriverTodaysDeliveries = function (driverId) {
  // Use environment variable for timezone offset (UAE = UTC+4 = 240 minutes)
  const TIMEZONE_OFFSET_MINUTES = parseInt(process.env.LOCAL_TIMEZONE_OFFSET_MINUTES || '240', 10);
  const uaeOffset = TIMEZONE_OFFSET_MINUTES * 60 * 1000; // Convert to milliseconds
  
  const nowUTC = new Date();
  const nowUAE = new Date(nowUTC.getTime() + uaeOffset);
  
  // Get today's date string in UAE timezone (YYYY-MM-DD)
  const todayStringUAE = nowUAE.toISOString().split('T')[0];
  
  // Convert UAE midnight to UTC for database query
  const uaeMidnight = new Date(todayStringUAE + 'T00:00:00.000Z');
  const startOfDay = new Date(uaeMidnight.getTime() - uaeOffset); // Convert back to UTC
  let endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1); // 23:59:59 UTC

  // Env-based controls for next-day visibility
  const ENABLE_EARLY_NEXT_DAY = String(process.env.ENABLE_EARLY_NEXT_DAY || '1') === '1';
  const NEXT_DAY_AVAILABLE_HOUR = parseInt(process.env.NEXT_DAY_AVAILABLE_HOUR || '16', 10);

  // If enabled and local time >= cutoff hour, include tomorrow's deliveries as available
  // Extend the query window to end of tomorrow
  //
  // IMPORTANT: nowUAE's epoch already encodes UAE wall-clock time as if it
  // were UTC (that's what the +uaeOffset shift above is for — same trick
  // used for todayStringUAE/startOfDay). It must be read with getUTCHours()
  // here, not getHours() — getHours() additionally applies the SERVER
  // PROCESS's own OS timezone on top, which silently breaks this check on
  // any server not literally configured for TZ=UTC. That's exactly why this
  // "show tomorrow's deliveries after 4pm" feature wasn't actually kicking
  // in: this server isn't running in UTC, so the old getHours() read was
  // several hours off from the real UAE hour and rarely/never crossed the
  // NEXT_DAY_AVAILABLE_HOUR threshold — drivers only saw next-day deliveries
  // once real UAE midnight passed and they became "today" outright.
  if (ENABLE_EARLY_NEXT_DAY && nowUAE.getUTCHours() >= NEXT_DAY_AVAILABLE_HOUR) {
    endOfDay = new Date(startOfDay.getTime() + 48 * 60 * 60 * 1000 - 1); // end of tomorrow (UTC)
  }

  return this.find({
    driver: driverId,
    scheduledTime: {
      $gte: startOfDay,
      $lte: endOfDay
    },
    status: { $in: ['pending', 'assigned', 'on_route', 'picked_up', 'delivered', 'failed', 'completed'] }
  }).sort({ routeOrder: 1, scheduledTime: 1 });
};

export default mongoose.model('Delivery', deliverySchema);
