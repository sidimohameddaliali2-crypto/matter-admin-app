import express from 'express';
import crypto from 'crypto';
import PartnerMenuItem from '../models/PartnerMenuItem.js';
import SpaceMenu from '../models/SpaceMenu.js';
import SpacePrice from '../models/SpacePrice.js';
import SpaceOrder, { isInLockWindow } from '../models/SpaceOrder.js';
import OrderLine from '../models/OrderLine.js';
import Invoice from '../models/Invoice.js';
import InvoiceLine from '../models/InvoiceLine.js';
import WasteLog, { WASTE_REASONS } from '../models/WasteLog.js';
import { partnerProtect } from '../middleware/partnerAuth.js';
import { sendNewOrderEmail } from '../services/emailService.js';
import { sendNewPartnerOrderSlack } from '../services/partnerOrderSlack.js';
import { emitPartnerKitchenChange } from '../services/partnerKitchenOrders.js';
import Partner from '../models/Partner.js';
import Member from '../models/Member.js';
import { normalizePartnerLines, validatePartnerOrder, isPartnerItemAvailable, partnerUnitPrice } from '../services/partnerOrderValidation.js';
import { partnerReportScope } from '../services/partnerReportScope.js';

const router = express.Router();
router.use(partnerProtect);

const buildJoinUrl = (req, token) => {
  const fallbackOrigin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
  return `${process.env.FRONTEND_URL || fallbackOrigin}/join/${token}`;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

// Deadline locking is derived from the delivery date. Only invoicing sets the
// stored status to locked; reading an order must never change its workflow.

// Get current price for a space+item pair
const currentPrice = async (spaceId, menuItemId) => {
  const sp = await SpacePrice
    .findOne({ space: spaceId, menuItem: menuItemId, effectiveFrom: { $lte: new Date() } })
    .sort({ effectiveFrom: -1 });
  return sp ? sp.price : null;
};

// Partner-facing unit price: partner's own price -> master selling price -> base price.
const effectiveUnitPrice = async (spaceId, menuItem) => {
  const own = menuItem ? await currentPrice(spaceId, menuItem._id) : null;
  return partnerUnitPrice(menuItem, own);
};

// Attach priced lines, total, invoice and edit permission to orders.
const decorateOrders = async (orders, spaceId) => {
  if (!orders.length) return [];
  const orderIds = orders.map(o => o._id);
  const lines = await OrderLine.find({ order: { $in: orderIds } }).populate('menuItem', 'name mealType price sellingPrice');
  const invoices = await Invoice.find({ space: spaceId, type: 'partner', order: { $in: orderIds } })
    .select('invoiceNumber totalRevenue order');

  const priced = await Promise.all(lines.map(async l => ({
    ...l.toObject(),
    unitPrice: await effectiveUnitPrice(spaceId, l.menuItem)
  })));

  return orders.map(o => {
    const key = String(o._id);
    const ls = priced.filter(l => String(l.order) === key);
    const inv = invoices.find(i => String(i.order) === key);
    return {
      ...o.toObject(),
      lines: ls,
      total: ls.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
      isLocked: isInLockWindow(o.deliveryDate),
      editable: ['draft', 'submitted'].includes(o.status) && !isInLockWindow(o.deliveryDate),
      invoice: inv ? { _id: inv._id, invoiceNumber: inv.invoiceNumber, totalRevenue: inv.totalRevenue } : null
    };
  });
};

// ─── Profile ──────────────────────────────────────────────────────────────────

// PATCH /api/partner/profile — update partner's own profile fields
router.patch('/profile', async (req, res) => {
  try {
    const allowed = ['defaultDeliveryTime'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const partner = await Partner.findByIdAndUpdate(req.partner._id, updates, { new: true });
    res.json({
      success: true,
      data: {
        defaultDeliveryTime: partner.defaultDeliveryTime
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Members ─────────────────────────────────────────────────────────────────

// GET /api/partner/members — this partner's member roster
router.get('/members', async (req, res) => {
  try {
    const members = await Member.find({ partner: req.partner._id })
      .select('name email dietaryExclusions isActive createdAt lastLogin')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: members });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/partner/members/invite-token — current invite token + join URL (may be null)
router.get('/members/invite-token', async (req, res) => {
  try {
    const token = req.partner.memberInviteToken || null;
    res.json({
      success: true,
      data: { inviteToken: token, joinUrl: token ? buildJoinUrl(req, token) : null }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/partner/members/invite-token — lazily create the invite token
router.post('/members/invite-token', async (req, res) => {
  try {
    let token = req.partner.memberInviteToken;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      await Partner.findByIdAndUpdate(req.partner._id, { memberInviteToken: token });
    }
    res.json({ success: true, data: { inviteToken: token, joinUrl: buildJoinUrl(req, token) } });
  } catch (err) {
    console.error('Member invite-token error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Menu ─────────────────────────────────────────────────────────────────────

// GET /api/partner/menu?date=YYYY-MM-DD — items assigned to this space, filtered by availability date
router.get('/menu', async (req, res) => {
  try {
    const spaceId = req.partner._id;
    const assignments = await SpaceMenu
      .find({ space: spaceId, isActive: true })
      .populate('menuItem');

    const prices = await SpacePrice.aggregate([
      { $match: { space: spaceId, effectiveFrom: { $lte: new Date() } } },
      { $sort: { menuItem: 1, effectiveFrom: -1 } },
      { $group: { _id: '$menuItem', price: { $first: '$price' } } }
    ]);
    const priceMap = {};
    prices.forEach(p => { priceMap[String(p._id)] = p.price; });

    // If a date param is provided, filter by the item's availability window
    const checkDate = req.query.date ? new Date(req.query.date) : null;
    if (checkDate) checkDate.setUTCHours(0, 0, 0, 0);

    const items = assignments
      .filter(a => {
        return checkDate ? isPartnerItemAvailable(a.menuItem, checkDate) : a.menuItem && a.menuItem.isAvailable !== false;
      })
      .map(a => ({
        ...a.menuItem.toObject(),
        price: partnerUnitPrice(a.menuItem, priceMap[String(a.menuItem._id)])
      }));

    res.json({ success: true, data: items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Orders ───────────────────────────────────────────────────────────────────

// GET /api/partner/orders
router.get('/orders', async (req, res) => {
  try {
    const spaceId = req.partner._id;

    const { status, from, to } = req.query;
    const q = { space: spaceId };
    if (status) q.status = status;
    if (from || to) {
      q.deliveryDate = {};
      if (from) q.deliveryDate.$gte = new Date(from);
      if (to) q.deliveryDate.$lte = new Date(to);
    }

    const orders = await SpaceOrder.find(q).sort({ deliveryDate: -1 });
    res.json({ success: true, data: await decorateOrders(orders, spaceId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/partner/orders/:id
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await SpaceOrder.findOne({ _id: req.params.id, space: req.partner._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const lines = await OrderLine.find({ order: order._id }).populate('menuItem', 'name mealType');
    res.json({ success: true, data: { ...order.toObject(), lines, isLocked: isInLockWindow(order.deliveryDate) } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/partner/orders — upsert a draft order for a delivery date
router.post('/orders', async (req, res) => {
  try {
    const { deliveryDate, lines, notes, deliveryTime, orderType, weekGroupId } = req.body;
    if (!deliveryDate) return res.status(400).json({ success: false, message: 'deliveryDate is required' });
    const deliveryDay = new Date(deliveryDate);
    if (!Number.isFinite(deliveryDay.getTime())) return res.status(400).json({ success: false, message: 'Invalid delivery date.' });
    deliveryDay.setUTCHours(0, 0, 0, 0);
    const changes = normalizePartnerLines(lines);

    const spaceId = req.partner._id;
    if (deliveryDay.getUTCDay() === 0) {
      return res.status(400).json({ success: false, message: 'There is no delivery on Sunday — pick another date.' });
    }
    if (isInLockWindow(deliveryDay)) {
      return res.status(400).json({ success: false, message: 'This delivery date is past its ordering deadline and can no longer be ordered for.' });
    }

    // Keep cancelled orders as history; a replacement starts as a new draft.
    let order = await SpaceOrder.findOne({ space: spaceId, deliveryDate: deliveryDay, status: { $ne: 'cancelled' } });
    if (order && !['draft', 'submitted'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Order is locked and cannot be edited.' });
    }
    const existingLines = order ? await OrderLine.find({ order: order._id }) : [];
    const proposed = new Map(existingLines.map(l => [String(l.menuItem), l.quantity]));
    changes.forEach(l => l.quantity > 0 ? proposed.set(l.menuItemId, l.quantity) : proposed.delete(l.menuItemId));
    await validatePartnerOrder({
      spaceId, deliveryDate: deliveryDay,
      lines: normalizePartnerLines([...proposed].map(([menuItemId, quantity]) => ({ menuItemId, quantity }))),
      requireItems: order?.status === 'submitted',
      minimumOrder: order?.status === 'submitted' ? Number(req.partner.minimumOrder) || 0 : 0
    });
    if (!order) {
      order = await SpaceOrder.create({
        space: spaceId, deliveryDate: deliveryDay, createdBy: spaceId,
        notes: notes || '',
        deliveryTime: deliveryTime || null,
        orderType: orderType || 'single',
        weekGroupId: weekGroupId || null
      });
    } else {
      if (notes !== undefined) order.notes = notes;
      if (deliveryTime !== undefined) order.deliveryTime = deliveryTime;
      await order.save();
    }

    // Upsert lines
    for (const line of changes) {
      const { menuItemId, quantity } = line;
      const qty = quantity;
      if (qty <= 0) {
        await OrderLine.deleteOne({ order: order._id, menuItem: menuItemId });
      } else {
        await OrderLine.findOneAndUpdate(
          { order: order._id, menuItem: menuItemId },
          { quantity: qty },
          { upsert: true, new: true, runValidators: true }
        );
      }
    }

    const updatedLines = await OrderLine.find({ order: order._id }).populate('menuItem', 'name mealType');
    if (order.status === 'submitted') emitPartnerKitchenChange(req, order);
    res.json({ success: true, data: { ...order.toObject(), lines: updatedLines } });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Server error' });
  }
});

// POST /api/partner/orders/:id/submit
router.post('/orders/:id/submit', async (req, res) => {
  try {
    const order = await SpaceOrder.findOne({ _id: req.params.id, space: req.partner._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'locked') return res.status(400).json({ success: false, message: 'Order is already locked.' });
    if (order.status === 'submitted') return res.status(400).json({ success: false, message: 'Order already submitted.' });
    if (order.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft orders can be submitted.' });
    if (isInLockWindow(order.deliveryDate)) return res.status(400).json({ success: false, message: 'Delivery date is past its ordering deadline.' });

    const lines = await OrderLine.find({ order: order._id });
    const { pricedLines, totalAmount } = await validatePartnerOrder({
      spaceId: req.partner._id, deliveryDate: order.deliveryDate,
      lines: normalizePartnerLines(lines.map(l => ({ menuItemId: String(l.menuItem), quantity: l.quantity }))),
      requireItems: true, minimumOrder: Number(req.partner.minimumOrder) || 0
    });

    order.status = 'submitted';
    order.submittedAt = new Date();
    await order.save();
    emitPartnerKitchenChange(req, order);

    // Alerts run only after submission is saved, never for drafts or rejected
    // submissions. Notification failures must not fail an accepted order.
    const notification = {
      partner: req.partner,
      order,
      lines: pricedLines.map(({ menuItem, quantity, unitPrice }) => ({
        itemName: menuItem.name,
        quantity,
        unitPrice,
        lineTotal: unitPrice * quantity,
      })),
      totalAmount,
    };
    sendNewOrderEmail(notification).catch(err => console.error('[email] Order notification failed:', err?.message || err));
    sendNewPartnerOrderSlack(notification).then(result => {
      if (!result.ok && !result.skipped) console.warn('[slack] Partner order alert failed:', result.error);
    }).catch(() => console.warn('[slack] Partner order alert failed; order remains submitted.'));

    res.json({ success: true, data: order });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Server error' });
  }
});

// DELETE /api/partner/orders/:id — delete draft only
router.delete('/orders/:id', async (req, res) => {
  try {
    const order = await SpaceOrder.findOne({ _id: req.params.id, space: req.partner._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft orders can be deleted.' });
    await OrderLine.deleteMany({ order: order._id });
    await order.deleteOne();
    res.json({ success: true, message: 'Order deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/partner/orders/:id/cancel
router.post('/orders/:id/cancel', async (req, res) => {
  try {
    const order = await SpaceOrder.findOne({ _id: req.params.id, space: req.partner._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'locked') return res.status(400).json({ success: false, message: 'Locked orders cannot be cancelled.' });
    if (order.status === 'cancelled') return res.status(400).json({ success: false, message: 'Order is already cancelled.' });
    if (isInLockWindow(order.deliveryDate)) {
      return res.status(400).json({ success: false, message: 'This order is past its ordering deadline and can no longer be cancelled.' });
    }
    order.status = 'cancelled';
    order.cancelledAt = new Date();
    await order.save();
    emitPartnerKitchenChange(req, order);
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Invoices ─────────────────────────────────────────────────────────────────

// GET /api/partner/invoices
router.get('/invoices', async (req, res) => {
  try {
    const invoices = await Invoice
      .find({ space: req.partner._id, type: 'partner' })
      .populate('order', 'deliveryDate notes')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: invoices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/partner/invoices/:id
router.get('/invoices/:id', async (req, res) => {
  try {
    const invoice = await Invoice
      .findOne({ _id: req.params.id, space: req.partner._id, type: 'partner' })
      .populate('order', 'deliveryDate notes');
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const lines = await InvoiceLine.find({ invoice: invoice._id });
    res.json({ success: true, data: { ...invoice.toObject(), lines } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Waste ────────────────────────────────────────────────────────────────────

// POST /api/partner/waste
router.post('/waste', async (req, res) => {
  try {
    const { deliveryDate, menuItemId, quantity, reason, note } = req.body;
    if (!deliveryDate || !menuItemId || !quantity || !reason) {
      return res.status(400).json({ success: false, message: 'deliveryDate, menuItemId, quantity and reason are required' });
    }
    if (!WASTE_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, message: `reason must be one of: ${WASTE_REASONS.join(', ')}` });
    }
    const item = await PartnerMenuItem.findById(menuItemId).select('name');
    if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });

    const log = await WasteLog.create({
      space: req.partner._id, deliveryDate: new Date(deliveryDate),
      menuItem: menuItemId, itemName: item.name,
      quantity: Number(quantity), party: 'partner', reason, note: note || '',
      createdById: req.partner._id, createdByModel: 'Partner'
    });
    res.status(201).json({ success: true, data: log });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/partner/waste
router.get('/waste', async (req, res) => {
  try {
    const { from, to } = req.query;
    const q = { space: req.partner._id };
    if (from || to) {
      q.deliveryDate = {};
      if (from) q.deliveryDate.$gte = new Date(from);
      if (to) q.deliveryDate.$lte = new Date(to);
    }
    const logs = await WasteLog.find(q).sort({ deliveryDate: -1 });
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

// GET /api/partner/reports
router.get('/reports', async (req, res) => {
  try {
    const spaceId = req.partner._id;
    const { from, to } = req.query;
    const { dateFilter, invoiceOrderFilter } = await partnerReportScope({ from, to, spaceId });

    // Orders summary
    const orderQ = { space: spaceId, status: { $in: ['submitted', 'locked'] } };
    if (from || to) orderQ.deliveryDate = dateFilter;
    const orders = await SpaceOrder.find(orderQ);
    const orderIds = orders.map(o => o._id);

    // Invoice totals
    const invQ = { space: spaceId, type: 'partner', status: 'locked', ...invoiceOrderFilter };
    const invoices = await Invoice.find(invQ).sort({ createdAt: -1 });
    const totalSpend = invoices.reduce((s, i) => s + i.totalRevenue, 0);

    // Top items from invoice lines
    const topItems = await InvoiceLine.aggregate([
      { $match: { invoice: { $in: invoices.map(i => i._id) } } },
      { $group: { _id: '$itemName', totalQty: { $sum: '$quantity' }, totalRevenue: { $sum: '$lineRevenue' } } },
      { $sort: { totalQty: -1 } },
      { $limit: 10 }
    ]);

    // Waste summary
    const wasteQ = { space: spaceId };
    if (from || to) wasteQ.deliveryDate = dateFilter;
    const waste = await WasteLog.aggregate([
      { $match: wasteQ },
      { $group: { _id: '$party', totalQty: { $sum: '$quantity' }, count: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      data: {
        orderCount: orders.length,
        invoiceCount: invoices.length,
        totalSpend,
        recentInvoices: invoices.slice(0, 5),
        topItems,
        waste
      }
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Server error' });
  }
});

export default router;
