import { effectivePermissions } from '../models/User.js';

const operationalProfile = ['firstName', 'lastName', 'phone', 'picture', 'status', 'colorCode', 'assignedZone', 'shiftTiming', 'vehicleId', 'vehicleType', 'stopCapacity', 'truckoomVehicleNo'];
const administrativeProfile = [...operationalProfile, 'department', 'position', 'licenseNumber', 'licenseExpiry', 'nationalId', 'vehiclePaper', 'baseSalary', 'contractType', 'joiningDate', 'vacation', 'deductions'];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const plain = value => typeof value?.toObject === 'function' ? value.toObject() : value;
export const isStaffAdmin = user => ['admin', 'super_admin'].includes(user?.role);
export const hasStaffPermission = (user, ...keys) => keys.some(key => effectivePermissions(user)[key] === true);
export const ownsStaffRecord = (user, id) => String(user?._id || user?.id) === String(id);

// Explicit response allowlists: future account fields must not become public
// just because a model gained a new property. Never expose push/session data.
export function staffResponse(user) {
  const data = plain(user);
  if (!data) return data;
  return { ...pick(data, ['_id', 'email', 'role', 'isActive', 'lastLogin', 'createdAt', 'updatedAt', 'kpi', 'dashboardLayout', 'permissionsConfigured']),
    profile: pick(plain(data.profile), administrativeProfile), permissions: effectivePermissions(data),
    ...(data.createdBy ? { createdBy: { _id: data.createdBy._id || data.createdBy,
      profile: pick(plain(data.createdBy.profile), ['firstName', 'lastName']) } } : {}) };
}
export function driverResponse(user, actor, { location = false, operational = false } = {}) {
  const data = plain(user);
  if (!data) return data;
  const administrative = !operational && isStaffAdmin(actor) && hasStaffPermission(actor, 'drivers');
  return { ...pick(data, ['_id', 'email', 'role', 'isActive', 'lastLogin', 'createdAt', 'updatedAt', 'kpi']),
    ...(location ? pick(data, ['location']) : {}),
    profile: pick(plain(data.profile), administrative ? administrativeProfile : operationalProfile) };
}
export function driverProjection(actor, { location = false, operational = false } = {}) {
  const fields = !operational && isStaffAdmin(actor) && hasStaffPermission(actor, 'drivers') ? administrativeProfile : operationalProfile;
  return ['_id', 'email', 'role', 'isActive', 'lastLogin', 'createdAt', 'updatedAt', 'kpi', ...(location ? ['location'] : []), ...fields.map(key => `profile.${key}`)].join(' ');
}

export const requireStaffPermission = (...keys) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Not authorized' });
  if (!hasStaffPermission(req.user, ...keys)) return res.status(403).json({ message: 'Access denied' });
  next();
};
export const requireDriverRead = ({ directory = false, location = false } = {}) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Not authorized' });
  const self = req.user.role === 'driver' && ownsStaffRecord(req.user, req.params.id);
  const keys = directory ? ['drivers', 'deliveries', 'fleet', 'live_map', 'bags', 'reports']
    : location ? ['drivers', 'deliveries', 'fleet', 'live_map'] : ['drivers'];
  const allowed = self || (req.user.role !== 'driver' && hasStaffPermission(req.user, ...keys))
    || (directory && req.user.role === 'driver' && hasStaffPermission(req.user, 'deliveries'));
  if (!allowed) return res.status(403).json({ message: 'Access denied' });
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function canManageStaffTarget(actor, target) {
  return isStaffAdmin(actor) && (target?.role !== 'super_admin' || actor.role === 'super_admin');
}
