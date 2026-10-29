import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  // Missing values on existing accounts are version zero. Password changes
  // advance this counter without imposing periodic logins on drivers.
  sessionVersion: {
    type: Number,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger
  },
  role: {
    type: String,
    enum: ['super_admin', 'admin', 'manager', 'dispatcher', 'driver', 'store_keeper', 'viewer', 'yellowblock_user', 'kitchen'],
    default: 'viewer'
  },
  profile: {
    firstName: String,
    lastName: String,
    phone: String,
    picture: String,
    department: String,
    position: String,
    status: {
      type: String,
      default: 'offline'
    },
    colorCode: {
      type: String,
      default: '#000000'
    },
    licenseNumber: String,
    licenseExpiry: Date,
    nationalId: String,
    assignedZone: String,
    shiftTiming: String,
    vehicleId: String,
    // Which Truckoom-tracked vehicle (their vehicle_no, e.g. "71591") this
    // driver's real GPS comes from — set manually on the driver's profile
    // (Drivers page), since Truckoom has no reliable field of its own
    // linking a vehicle to a driver (see services/truckoomApiService.js).
    // Null for drivers with no tracked vehicle.
    truckoomVehicleNo: {
      type: String,
      default: null
    },
    vehicleType: {
      type: String,
      enum: ['bike', 'van', 'car']
    },
    // Max stops per optimized route for this driver. Optional — when unset,
    // route optimization falls back to the vehicle-type default (see
    // VEHICLE_STOP_CAPACITY in services/routeOptimizationService.js).
    stopCapacity: Number,
    vehiclePaper: String,
    baseSalary: Number,
    contractType: {
      type: String,
      enum: ['full_time', 'part_time', 'contract', 'temporary'],
      default: 'full_time'
    },
    joiningDate: Date,
    vacation: {
      allowanceDays: { type: Number, default: 30 },
      usedDays: { type: Number, default: 0 },
      currentStart: Date,
      currentEnd: Date,
      history: [{
        startDate: Date,
        endDate: Date,
        days: Number,
        reason: String,
        loggedAt: { type: Date, default: Date.now }
      }]
    },
    deductions: [{
      reason: String,
      category: { type: String, enum: ['fine', 'damage', 'other'], default: 'other' },
      amount: { type: Number, default: 0 },
      date: { type: Date, default: Date.now }
    }]
  },
  permissions: {
    dashboard: { type: Boolean, default: false },
    users: { type: Boolean, default: false },
    drivers: { type: Boolean, default: false },
    fleet: { type: Boolean, default: false },
    deliveries: { type: Boolean, default: false },
    customers: { type: Boolean, default: false },
    website_subscriptions: { type: Boolean, default: false },
    subscription: { type: Boolean, default: false },
    customer_analytics: { type: Boolean, default: false },
    renewal: { type: Boolean, default: false },
    events: { type: Boolean, default: false },
    bags: { type: Boolean, default: false },
    late_deliveries: { type: Boolean, default: false },
    complaints: { type: Boolean, default: false },
    reports: { type: Boolean, default: false },
    delivery_changes: { type: Boolean, default: false },
    menus: { type: Boolean, default: false },
    kitchen_list: { type: Boolean, default: false },
    kitchen_counting: { type: Boolean, default: false },
    matter_core: { type: Boolean, default: false },
    partners: { type: Boolean, default: false },
    employees: { type: Boolean, default: false },
    settings: { type: Boolean, default: false },
    live_map: { type: Boolean, default: false },
    yellowblock: { type: Boolean, default: false }
  },
  // false = permissions have never been explicitly set for this user, so page
  // visibility falls back to the role defaults. true = an admin configured them
  // in the permissions modal, so the stored object is authoritative (an explicit
  // `false` genuinely hides that page).
  permissionsConfigured: { type: Boolean, default: false },
  location: {
    latitude: Number,
    longitude: Number,
    lastUpdated: Date,
    address: String
  },
  pushTokens: [{
    token: { type: String, required: true },
    platform: { type: String, enum: ['ios', 'android'] },
    addedAt: { type: Date, default: Date.now }
  }],
  kpi: {
    score: { type: Number, default: 0 },
    // avgLateTime / accuracyRate: pre-existing field names the UI reads
    // (Drivers.js, DriverDetail.js) — now hold the current month's Average
    // Delay (late deliveries only) and On-Time Delivery Rate, computed by
    // services/driverKpiService.js.
    avgLateTime: { type: Number, default: 0 },
    accuracyRate: { type: Number, default: 0 },
    complaintsCount: { type: Number, default: 0 },
    // Month-to-date driver scorecard (see services/driverKpiService.js)
    updateRate: { type: Number, default: 0 },
    totalDeliveries: { type: Number, default: 0 },
    onTimeDeliveries: { type: Number, default: 0 },
    lateDeliveries: { type: Number, default: 0 },
    updatedDeliveries: { type: Number, default: 0 },
    period: { type: String, default: '' }, // 'YYYY-MM' the numbers above reflect
    lastCalculatedAt: { type: Date, default: null }
  },
  dashboardLayout: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: Date,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  // Use an atomic increment: concurrent password changes must each revoke the
  // preceding sessions, even when both loaded the same account version.
  if (!this.isNew) this.$inc('sessionVersion', 1);
  next();
});

userSchema.methods.correctPassword = async function(candidatePassword, userPassword) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

// Only re-seed permissions from role defaults when the role changed AND the
// caller didn't also send an explicit permissions object in the same save.
// (Previously a role change always wiped custom permissions the admin had just
// set in the modal, because the modal sends role + permissions together.)
userSchema.pre('save', function(next) {
  if (this.isModified('role') && !this.isModified('permissions')) {
    this.permissions = getDefaultPermissions(this.role);
    // Role changed on its own — go back to "follows role defaults" mode.
    this.permissionsConfigured = false;
  }
  next();
});

// Canonical list of page-permission keys. MUST stay in sync with
// client/src/constants/permissions.js. The trailing group are legacy/non-page
// keys kept so existing documents and any old checks don't break.
const PERMISSION_KEYS = [
  'dashboard',
  'deliveries', 'drivers', 'fleet', 'delivery_changes', 'bags', 'reports', 'events', 'complaints',
  'customers', 'website_subscriptions', 'subscription', 'customer_analytics', 'renewal',
  'menus', 'kitchen_list', 'kitchen_counting', 'matter_core',
  'partners',
  'users', 'employees',
  'late_deliveries', 'live_map', 'settings', 'yellowblock',
];

// Which keys default to ON for each role. A role missing here gets nothing.
const ROLE_DEFAULT_KEYS = {
  super_admin: PERMISSION_KEYS,
  admin: [
    'dashboard', 'deliveries', 'drivers', 'fleet', 'delivery_changes', 'bags', 'reports', 'events', 'complaints',
    'customers', 'website_subscriptions', 'subscription', 'customer_analytics', 'renewal',
    'menus', 'kitchen_list', 'kitchen_counting', 'matter_core', 'partners', 'users', 'employees',
    'late_deliveries', 'live_map',
  ],
  manager: [
    'dashboard', 'deliveries', 'bags', 'reports', 'customers',
    'website_subscriptions', 'subscription', 'customer_analytics', 'renewal', 'employees',
    'late_deliveries', 'live_map',
  ],
  dispatcher: [
    'dashboard', 'deliveries', 'bags', 'events', 'complaints', 'customers',
    'late_deliveries', 'live_map',
  ],
  driver: ['dashboard', 'deliveries'],
  viewer: ['dashboard', 'reports'],
  store_keeper: ['bags'],
  yellowblock_user: ['events', 'yellowblock'],
  kitchen: ['kitchen_list', 'kitchen_counting', 'partners'],
};

function getDefaultPermissions(role) {
  const on = new Set(ROLE_DEFAULT_KEYS[role] || []);
  const out = {};
  PERMISSION_KEYS.forEach((key) => { out[key] = on.has(key); });
  return out;
}

// The permission set the app should actually enforce for a user:
// - super_admin always gets everything
// - unconfigured users fall back entirely to role defaults
// - configured users: their stored value wins for every key it has (true OR
//   false); role defaults only fill keys added after they were configured.
function effectivePermissions(user) {
  if (!user) return {};
  if (user.role === 'super_admin') return getDefaultPermissions('super_admin');
  const defaults = getDefaultPermissions(user.role);
  if (!user.permissionsConfigured) return defaults;
  const stored = user.permissions
    ? (typeof user.permissions.toObject === 'function' ? user.permissions.toObject() : { ...user.permissions })
    : {};
  const merged = { ...defaults };
  Object.keys(defaults).forEach((key) => {
    if (typeof stored[key] === 'boolean') merged[key] = stored[key];
  });
  return merged;
}

export { getDefaultPermissions, effectivePermissions, PERMISSION_KEYS };
export default mongoose.model('User', userSchema);
