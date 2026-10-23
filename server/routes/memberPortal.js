import express from 'express';
import SpaceMenu from '../models/SpaceMenu.js';
import SpacePrice from '../models/SpacePrice.js';
import { isInLockWindow } from '../models/SpaceOrder.js';
import MemberOrder from '../models/MemberOrder.js';
import MemberOrderLine from '../models/MemberOrderLine.js';
import Member from '../models/Member.js';
import { memberProtect } from '../middleware/memberAuth.js';
import { sendNewMemberOrderEmail } from '../services/emailService.js';

const router = express.Router();
router.use(memberProtect);

// ─── helpers (mirrored from partnerPortal.js) ────────────────────────────────

const autoLockOrders = async (memberId) => {
  const submitted = await MemberOrder.find({ member: memberId, status: 'submitted' });
  const tolock = submitted.filter(o => isInLockWindow(o.deliveryDate));
  if (tolock.length) {
    await MemberOrder.updateMany(
      { _id: { $in: tolock.map(o => o._id) } },
      { $set: { status: 'locked', lockedAt: new Date() } }
    );
  }
};

const currentPrice = async (spaceId, menuItemId) => {
  const sp = await SpacePrice
    .findOne({ space: spaceId, menuItem: menuItemId, effectiveFrom: { $lte: new Date() } })
    .sort({ effectiveFrom: -1 });
  return sp ? sp.price : null;
};

// ─── Profile ─────────────────────────────────────────────────────────────────

// PATCH /api/member/profile — member edits their own name / exclusions
router.patch('/profile', async (req, res) => {
  try {
    const allowed = ['name', 'dietaryExclusions'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const member = await Member.findByIdAndUpdate(req.member._id, updates, { new: true });
    res.json({
      success: true,
      data: { name: member.name, email: member.email, dietaryExclusions: member.dietaryExclusions }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Menu ────────────────────────────────────────────────────────────────────

// GET /api/member/menu?date=YYYY-MM-DD — the partner's assigned menu + current prices
router.get('/menu', async (req, res) => {
  try {
    const spaceId = req.member.partner._id;
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

    const checkDate = req.query.date ? new Date(req.query.date) : null;
    if (checkDate) checkDate.setUTCHours(0, 0, 0, 0);

    const items = assignments
      .filter(a => {
        if (!a.menuItem || a.menuItem.isAvailable === false) return false;
        if (!checkDate) return true;
        const item = a.menuItem;
        if (item.availableFrom) {
          const from = new Date(item.availableFrom); from.setUTCHours(0, 0, 0, 0);
          if (checkDate < from) return false;
        }
        if (item.availableTo) {
          const to = new Date(item.availableTo); to.setUTCHours(0, 0, 0, 0);
          if (checkDate > to) return false;
        }
        return true;
      })
      .map(a => ({
        ...a.menuItem.toObject(),
        price: priceMap[String(a.menuItem._id)] ?? a.menuItem.sellingPrice ?? null
      }));

    res.json({ success: true, data: items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Orders ──────────────────────────────────────────────────────────────────

// GET /api/member/orders
router.get('/orders', async (req, res) => {
  try {
    const memberId = req.member._id;
    await autoLockOrders(memberId);

    const orders = await MemberOrder.find({ member: memberId }).sort({ deliveryDate: -1 });
    const orderIds = orders.map(o => o._id);
    const lines = await MemberOrderLine.find({ order: { $in: orderIds } }).populate('menuItem', 'name mealType price');

    const linesByOrder = {};
    lines.forEach(l => {
      const key = String(l.order);
      if (!linesByOrder[key]) linesByOrder[key] = [];
      linesByOrder[key].push(l);
    });

    const result = orders.map(o => ({
      ...o.toObject(),
      lines: linesByOrder[String(o._id)] || [],
      isLocked: isInLockWindow(o.deliveryDate)
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/member/orders/:id
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await MemberOrder.findOne({ _id: req.params.id, member: req.member._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const lines = await MemberOrderLine.find({ order: order._id }).populate('menuItem', 'name mealType');
    res.json({ success: true, data: { ...order.toObject(), lines, isLocked: isInLockWindow(order.deliveryDate) } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/member/orders — upsert a draft order for a delivery date
router.post('/orders', async (req, res) => {
  try {
    const { deliveryDate, lines, notes, deliveryTime } = req.body;
    if (!deliveryDate) return res.status(400).json({ success: false, message: 'deliveryDate is required' });
    if (!Array.isArray(lines)) return res.status(400).json({ success: false, message: 'lines must be an array' });

    const memberId = req.member._id;
    if (new Date(deliveryDate).getUTCDay() === 0) {
      return res.status(400).json({ success: false, message: 'There is no delivery on Sunday — pick another date.' });
    }
    if (isInLockWindow(deliveryDate)) {
      return res.status(400).json({ success: false, message: 'This delivery date is past its ordering deadline and can no longer be ordered for.' });
    }

    let order = await MemberOrder.findOne({ member: memberId, deliveryDate: new Date(deliveryDate) });
    if (!order) {
      order = await MemberOrder.create({
        member: memberId,
        partner: req.member.partner._id,
        deliveryDate: new Date(deliveryDate),
        notes: notes || '',
        deliveryTime: deliveryTime || null
      });
    } else {
      if (order.status === 'locked') return res.status(400).json({ success: false, message: 'Order is locked and cannot be edited.' });
      if (notes !== undefined) order.notes = notes;
      if (deliveryTime !== undefined) order.deliveryTime = deliveryTime;
      await order.save();
    }

    for (const line of lines) {
      const { menuItemId, quantity } = line;
      if (!menuItemId) continue;
      const qty = Number(quantity) || 0;
      if (qty <= 0) {
        await MemberOrderLine.deleteOne({ order: order._id, menuItem: menuItemId });
      } else {
        await MemberOrderLine.findOneAndUpdate(
          { order: order._id, menuItem: menuItemId },
          { quantity: qty },
          { upsert: true, new: true }
        );
      }
    }

    const updatedLines = await MemberOrderLine.find({ order: order._id }).populate('menuItem', 'name mealType');
    res.json({ success: true, data: { ...order.toObject(), lines: updatedLines } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/member/orders/:id/submit
router.post('/orders/:id/submit', async (req, res) => {
  try {
    const order = await MemberOrder.findOne({ _id: req.params.id, member: req.member._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'locked') return res.status(400).json({ success: false, message: 'Order is already locked.' });
    if (order.status === 'submitted') return res.status(400).json({ success: false, message: 'Order already submitted.' });
    if (isInLockWindow(order.deliveryDate)) return res.status(400).json({ success: false, message: 'Delivery date is past its ordering deadline.' });

    const lines = await MemberOrderLine.find({ order: order._id }).populate('menuItem', 'name');
    if (!lines.length) return res.status(400).json({ success: false, message: 'Order has no items.' });

    const spaceId = req.member.partner._id;
    const priced = await Promise.all(lines.map(async (l) => {
      const unitPrice = (await currentPrice(spaceId, l.menuItem?._id || l.menuItem)) || 0;
      return {
        itemName: l.menuItem?.name || '—',
        quantity: l.quantity,
        unitPrice,
        lineTotal: unitPrice * l.quantity
      };
    }));
    const totalAmount = priced.reduce((sum, l) => sum + l.lineTotal, 0);

    const min = req.member.partner.minimumOrder ?? 0;
    if (min && totalAmount < min) {
      return res.status(400).json({ success: false, message: `Minimum order is AED ${min.toFixed(2)}. Current total: AED ${totalAmount.toFixed(2)}.` });
    }

    order.status = 'submitted';
    order.submittedAt = new Date();
    await order.save();

    sendNewMemberOrderEmail({
      member: req.member,
      partner: req.member.partner,
      order,
      lines: priced,
      totalAmount,
    }).catch(err => console.error('[email] Member order notification failed:', err?.message || err));

    res.json({ success: true, data: order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/member/orders/:id — delete draft only
router.delete('/orders/:id', async (req, res) => {
  try {
    const order = await MemberOrder.findOne({ _id: req.params.id, member: req.member._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft orders can be deleted.' });
    await MemberOrderLine.deleteMany({ order: order._id });
    await order.deleteOne();
    res.json({ success: true, message: 'Order deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/member/orders/:id/cancel
router.post('/orders/:id/cancel', async (req, res) => {
  try {
    const order = await MemberOrder.findOne({ _id: req.params.id, member: req.member._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'locked') return res.status(400).json({ success: false, message: 'Locked orders cannot be cancelled.' });
    if (order.status === 'cancelled') return res.status(400).json({ success: false, message: 'Order is already cancelled.' });
    if (isInLockWindow(order.deliveryDate)) {
      return res.status(400).json({ success: false, message: 'This order is past its ordering deadline and can no longer be cancelled.' });
    }
    order.status = 'cancelled';
    order.cancelledAt = new Date();
    await order.save();
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
