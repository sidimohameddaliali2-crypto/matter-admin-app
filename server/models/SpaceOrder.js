import mongoose from 'mongoose';
import { FIXED_SELECTION_DEADLINES } from '../config/selectionDeadlines.js';

const spaceOrderSchema = new mongoose.Schema({
  space: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner', required: true },
  deliveryDate: { type: Date, required: true },
  status: { type: String, enum: ['draft', 'submitted', 'locked', 'cancelled'], default: 'draft' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner' },
  submittedAt: Date,
  // Admin "Acknowledge" step (Partner Admin Orders tab) — a lightweight
  // confirmation before locking/invoicing, orthogonal to `status` so it
  // doesn't disturb the draft/submitted/locked/cancelled state machine
  // every other consumer (partner/member portals) already relies on.
  acknowledgedAt: Date,
  lockedAt: Date,
  notes: { type: String, default: '' },
  deliveryTime: { type: String, default: null },
  orderType: { type: String, enum: ['single', 'weekly'], default: 'single' },
  weekGroupId: { type: String, default: null }
}, { timestamps: true });

spaceOrderSchema.index({ space: 1, deliveryDate: 1 });
spaceOrderSchema.index({ status: 1, deliveryDate: 1 });

// Owner (2026-10-26): partner/member ordering now locks on the exact same
// per-weekday schedule as the customer Menu Selection (FIXED_SELECTION_
// DEADLINES), instead of a flat "2 days before" rule. Mirrors the client's
// isPastSelectionDeadline (client/.../MenuSelectionLink.jsx) — same table,
// same day-of-week lookup, same deadlineTime, same :59.999 inclusive cutoff.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Helpers used in routes — export alongside model
export const lockCutoff = (deliveryDate) => {
  const d = new Date(deliveryDate);
  const rule = FIXED_SELECTION_DEADLINES.find((r) => r.deliveryDay === DAY_NAMES[d.getDay()]);
  const daysBefore = rule?.daysBefore ?? 2;
  const [hh, mm] = String(rule?.deadlineTime || '00:00').split(':').map(Number);
  const cutoff = new Date(d);
  cutoff.setDate(cutoff.getDate() - daysBefore);
  cutoff.setHours(hh, mm, 59, 999);
  return cutoff;
};

export const isInLockWindow = (deliveryDate) => new Date() > lockCutoff(deliveryDate);

export default mongoose.model('SpaceOrder', spaceOrderSchema);
