import mongoose from 'mongoose';

const bagSchema = new mongoose.Schema({
  // Absent on legacy records until an explicit physical observation. Never
  // default old inventory to ready or verified (owner, 2026-10-22).
  lifecycleState: {type:String,enum:['ready','packed','outbound','with_customer','collected','received','cleaning','quarantined','retired']},
  custodyVersion: {type:Number},
  verifiedAt: Date,
  lastCustomer: {customerId:String,customerName:String},
  pendingHandover: {driver:{type:mongoose.Schema.Types.ObjectId,ref:'User'},preparedBy:{type:mongoose.Schema.Types.ObjectId,ref:'User'},preparedAt:Date,transfer:Boolean},
  damageEvidence: {description:String,proofPhotoUrl:String,reportedBy:{type:mongoose.Schema.Types.ObjectId,ref:'User'},reportedAt:Date},
  bagId: {
    type: String,
    required: [true, 'Bag ID is required'],
    unique: true,
    trim: true,
    uppercase: true
  },
  status: {
    type: String,
    enum: ['available', 'assigned', 'in_use', 'maintenance', 'retired'],
    default: 'available'
  },
  bagType: {
    type: String,
    enum: ['standard', 'on_time_use'],
    default: 'standard'
  },
  returnLocation: {
    lat: Number,
    lng: Number,
    accuracy: Number
  },
  returnedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  returnedByName: String,
  returnedAt: Date,
  condition: {
    type: String,
    enum: ['excellent', 'good', 'fair', 'poor'],
    default: 'good'
  },
  location: {
    type: String,
    enum: ['warehouse', 'driver', 'customer'],
    default: 'warehouse'
  },
  assignedTo: {
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    assignedByName: String,
    customer: {
      customerId: String,
      customerName: String
    },
    assignmentTime: Date,
    expectedReturn: Date
  },
  currentDelivery: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Delivery'
  },
  lastMaintenance: Date,
  maintenanceNotes: String,
  purchaseDate: Date,
  expectedLifespan: Number, // in months
  qrCode: String,
  notes: String,
  isActive: {
    type: Boolean,
    default: true
  },
  quantity: {
    type: Number,
    default: 1,
    min: 1
  },
  isFlagged: {
    type: Boolean,
    default: false
  },
  flagReason: String,
  flaggedAt: Date,
  quantityHistory: [{
    oldQuantity: Number,
    newQuantity: Number,
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    changedByName: String,
    reason: String,
    note: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  history: [{
    eventId:String,
    fingerprint:String,
    scanCode:String,
    occurredAt:Date,
    lifecycleState:String,
    proofPhotoUrl:String,
    before:mongoose.Schema.Types.Mixed,
    reassignment:mongoose.Schema.Types.Mixed,
    eventType: String,
    status: String,
    location: String,
    assignedBy: {
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      name: String
    },
    assignedTo: {
      driver: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      driverName: String,
      customer: {
        customerId: String,
        customerName: String
      }
    },
    notes: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

// Indexes
bagSchema.index({ bagId: 1 });
bagSchema.index({ status: 1 });
bagSchema.index({ location: 1 });
bagSchema.index({ 'assignedTo.driver': 1 });
bagSchema.index({ currentDelivery: 1 });

// Static method to get available bags
bagSchema.statics.getAvailableBags = function() {
  return this.find({
    status: 'available',
    isActive: true
  });
};

// Add to history when status changes
bagSchema.pre('save', function(next) {
  if (this.isModified('status') || this.isModified('location') || this.isModified('assignedTo')) {
    const overrideEntry = this.$locals && this.$locals.historyEntryOverride;
    if (overrideEntry) {
      this.history.push(overrideEntry);
      delete this.$locals.historyEntryOverride;
      if (this.$locals) {
        delete this.$locals.historyNote;
      }
      return next();
    }

    const historyNote =
      (this.$locals && this.$locals.historyNote) || 'Status updated';
    this.history.push({
      status: this.status,
      location: this.location,
      assignedBy: {
        user: this.assignedTo?.assignedBy,
        name: this.assignedTo?.assignedByName,
      },
      assignedTo: this.assignedTo,
      notes: historyNote
    });
    if (this.$locals) {
      delete this.$locals.historyNote;
    }
  }
  next();
});

// Static method to get bags assigned to driver
bagSchema.statics.getDriverBags = function(driverId) {
  return this.find({
    'assignedTo.driver': driverId,
    location: 'driver',
    isActive: true
  }).populate('assignedTo.driver', 'profile firstName lastName');
};

// Legacy direct state writes are intentionally unavailable. Every physical
// transition must include an actor, event ID and atomic movement history.
bagSchema.methods.assignToDriver = function(){throw new Error('Use verified bag preparation and receiving acceptance.');};
bagSchema.methods.returnToWarehouse = function(){throw new Error('Use an authorized warehouse receipt movement.');};

export default mongoose.model('Bag', bagSchema);
