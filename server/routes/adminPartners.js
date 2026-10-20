import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client } from '../config/spaces.js';
import Partner from '../models/Partner.js';
import PartnerMenuItem from '../models/PartnerMenuItem.js';
import SpaceMenu from '../models/SpaceMenu.js';
import SpacePrice from '../models/SpacePrice.js';
import ItemCost from '../models/ItemCost.js';
import SpaceOrder, { isInLockWindow } from '../models/SpaceOrder.js';
import OrderLine from '../models/OrderLine.js';
import Invoice from '../models/Invoice.js';
import InvoiceLine from '../models/InvoiceLine.js';
import WasteLog, { WASTE_REASONS } from '../models/WasteLog.js';
import Member from '../models/Member.js';
import MemberOrder from '../models/MemberOrder.js';
import { protect, admin, authorize } from '../middleware/auth.js';
import { assignMenuSelectionItemsToPartner } from '../services/menuSelectionPartnerSync.js';

const adminOrKitchen = authorize(['admin', 'super_admin', 'kitchen']);

const router = express.Router();
router.use(protect, adminOrKitchen);

// NOTE: All literal routes are defined before /:id parameterized routes to
// prevent Express matching "menu", "costs", "orders", etc. as an id param.

// ════════════════════════════════════════════════════════════════════════
// MASTER MENU ITEMS
// ════════════════════════════════════════════════════════════════════════

router.get('/menu', async (req, res) => {
  try {
    const items = await PartnerMenuItem.find().sort({ mealType: 1, sortOrder: 1, createdAt: 1 });
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/menu', async (req, res) => {
  try {
    const { name, mealType, description, price, sellingPrice, isAvailable, category, sortOrder, availableFrom, availableTo, ingredients } = req.body;
    if (!name || !mealType || price === undefined) {
      return res.status(400).json({ success: false, message: 'name, mealType and price are required' });
    }
    const item = await PartnerMenuItem.create({ name, mealType, description, price, sellingPrice: sellingPrice === '' || sellingPrice == null ? null : Number(sellingPrice), isAvailable, category, sortOrder, availableFrom: availableFrom || null, availableTo: availableTo || null, ingredients: Array.isArray(ingredients) ? ingredients : [] });
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/menu/:itemId', admin, async (req, res) => {
  try {
    const allowed = ['name', 'mealType', 'description', 'price', 'sellingPrice', 'isAvailable', 'category', 'sortOrder', 'availableFrom', 'availableTo', 'ingredients'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    const item = await PartnerMenuItem.findByIdAndUpdate(req.params.itemId, { $set: updates }, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    console.error('Menu item update failed:', err);
    res.status(400).json({ success: false, message: err.message || 'Server error' });
  }
});

router.delete('/menu/:itemId', admin, async (req, res) => {
  try {
    const item = await PartnerMenuItem.findByIdAndDelete(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// ITEM COSTS (COGS) — never exposed to partners
// ════════════════════════════════════════════════════════════════════════

router.get('/costs', async (req, res) => {
  try {
    const costs = await ItemCost.aggregate([
      { $match: { effectiveFrom: { $lte: new Date() } } },
      { $sort: { menuItem: 1, effectiveFrom: -1 } },
      { $group: { _id: '$menuItem', cost: { $first: '$cost' }, effectiveFrom: { $first: '$effectiveFrom' } } },
      { $lookup: { from: 'partnermenuitems', localField: '_id', foreignField: '_id', as: 'item' } },
      { $unwind: { path: '$item', preserveNullAndEmptyArrays: true } }
    ]);
    res.json({ success: true, data: costs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/costs', async (req, res) => {
  try {
    const { menuItemId, cost } = req.body;
    if (!menuItemId || cost === undefined) {
      return res.status(400).json({ success: false, message: 'menuItemId and cost required' });
    }
    const entry = await ItemCost.create({ menuItem: menuItemId, cost: Number(cost) });
    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// PRICES — set per-space sell price
// ════════════════════════════════════════════════════════════════════════

router.patch('/prices', async (req, res) => {
  try {
    const { spaceId, menuItemId, price } = req.body;
    if (!spaceId || !menuItemId || price === undefined) {
      return res.status(400).json({ success: false, message: 'spaceId, menuItemId and price required' });
    }
    const sp = await SpacePrice.create({ space: spaceId, menuItem: menuItemId, price: Number(price) });
    res.json({ success: true, data: sp });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════════════════════════════

router.get('/orders/all', async (req, res) => {
  try {
    const { status, spaceId, from, to } = req.query;
    const q = {};
    if (status) q.status = status;
    if (spaceId) q.space = spaceId;
    if (from || to) {
      q.deliveryDate = {};
      if (from) q.deliveryDate.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); q.deliveryDate.$lte = d; }
    }
    const orders = await SpaceOrder.find(q)
      .populate('space', 'businessName businessType email')
      .sort({ deliveryDate: 1, createdAt: -1 });
    const orderIds = orders.map(o => o._id);
    const lines = await OrderLine.find({ order: { $in: orderIds } }).populate('menuItem', 'name mealType');
    const linesByOrder = {};
    lines.forEach(l => {
      const k = String(l.order);
      if (!linesByOrder[k]) linesByOrder[k] = [];
      linesByOrder[k].push(l);
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

router.get('/orders/:orderId', async (req, res) => {
  try {
    const order = await SpaceOrder.findById(req.params.orderId)
      .populate('space', 'businessName businessType email contactName phone address');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const lines = await OrderLine.find({ order: order._id }).populate('menuItem', 'name mealType category');
    res.json({ success: true, data: { ...order.toObject(), lines } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Acknowledge a submitted order — a lightweight confirmation step before
// locking/invoicing. Does not touch `status`.
router.patch('/orders/:orderId/acknowledge', admin, async (req, res) => {
  try {
    const order = await SpaceOrder.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'submitted') {
      return res.status(400).json({ success: false, message: 'Only submitted orders can be acknowledged.' });
    }
    order.acknowledgedAt = new Date();
    await order.save();
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/orders/:orderId/status', admin, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['draft', 'submitted', 'locked'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(', ')}` });
    }
    const order = await SpaceOrder.findByIdAndUpdate(req.params.orderId, { status }, { new: true })
      .populate('space', 'businessName');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Lock order and generate both partner invoice + matter statement
router.patch('/orders/:orderId/lock', admin, async (req, res) => {
  try {
    const order = await SpaceOrder.findById(req.params.orderId).populate('space');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'locked') return res.status(400).json({ success: false, message: 'Already locked' });

    const lines = await OrderLine.find({ order: order._id }).populate('menuItem');
    if (!lines.length) return res.status(400).json({ success: false, message: 'No order lines to lock' });

    const spaceObjId = new mongoose.Types.ObjectId(String(order.space._id));

    // Current sell prices for this space
    const prices = await SpacePrice.aggregate([
      { $match: { space: spaceObjId, effectiveFrom: { $lte: new Date() } } },
      { $sort: { menuItem: 1, effectiveFrom: -1 } },
      { $group: { _id: '$menuItem', price: { $first: '$price' } } }
    ]);
    const priceMap = {};
    prices.forEach(p => { priceMap[String(p._id)] = p.price; });

    // Current COGS
    const itemIds = lines.map(l => new mongoose.Types.ObjectId(String(l.menuItem._id)));
    const costs = await ItemCost.aggregate([
      { $match: { menuItem: { $in: itemIds }, effectiveFrom: { $lte: new Date() } } },
      { $sort: { menuItem: 1, effectiveFrom: -1 } },
      { $group: { _id: '$menuItem', cost: { $first: '$cost' } } }
    ]);
    const costMap = {};
    costs.forEach(c => { costMap[String(c._id)] = c.cost; });

    // Lock the order
    order.status = 'locked';
    order.lockedAt = new Date();
    await order.save();

    // Build snapshots
    let totalRevenue = 0, totalCost = 0;
    const snapshots = lines.map(l => {
      const unitPrice = priceMap[String(l.menuItem._id)] ?? l.menuItem.sellingPrice ?? l.menuItem.price ?? 0;
      const unitCost = costMap[String(l.menuItem._id)] ?? 0;
      const lineRevenue = l.quantity * unitPrice;
      const lineCost = l.quantity * unitCost;
      totalRevenue += lineRevenue;
      totalCost += lineCost;
      return { menuItem: l.menuItem._id, itemName: l.menuItem.name, quantity: l.quantity, unitPrice, unitCost, lineRevenue, lineCost, lineMargin: lineRevenue - lineCost };
    });

    // Partner invoice (no cost info)
    let partnerInv = await Invoice.findOne({ order: order._id, type: 'partner' });
    if (partnerInv) {
      await InvoiceLine.deleteMany({ invoice: partnerInv._id });
      partnerInv.totalRevenue = totalRevenue;
      partnerInv.status = 'locked';
      partnerInv.lockedAt = new Date();
      await partnerInv.save();
    } else {
      partnerInv = await Invoice.create({ order: order._id, space: order.space._id, type: 'partner', totalRevenue, status: 'locked', lockedAt: new Date() });
    }
    await InvoiceLine.insertMany(snapshots.map(s => ({ invoice: partnerInv._id, menuItem: s.menuItem, itemName: s.itemName, quantity: s.quantity, unitPrice: s.unitPrice, unitCost: 0, lineRevenue: s.lineRevenue, lineCost: 0, lineMargin: 0 })));

    // Matter statement (with COGS + margin)
    let matterInv = await Invoice.findOne({ order: order._id, type: 'matter' });
    if (matterInv) {
      await InvoiceLine.deleteMany({ invoice: matterInv._id });
      matterInv.totalRevenue = totalRevenue;
      matterInv.totalCost = totalCost;
      matterInv.totalMargin = totalRevenue - totalCost;
      matterInv.status = 'locked';
      matterInv.lockedAt = new Date();
      await matterInv.save();
    } else {
      matterInv = await Invoice.create({ order: order._id, space: order.space._id, type: 'matter', totalRevenue, totalCost, totalMargin: totalRevenue - totalCost, status: 'locked', lockedAt: new Date() });
    }
    await InvoiceLine.insertMany(snapshots.map(s => ({ invoice: matterInv._id, ...s })));

    res.json({ success: true, data: { order, partnerInvoice: partnerInv, matterStatement: matterInv } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// INVOICES
// ════════════════════════════════════════════════════════════════════════

router.get('/invoices/all', async (req, res) => {
  try {
    const { type, spaceId } = req.query;
    const q = {};
    if (type) q.type = type;
    if (spaceId) q.space = spaceId;
    const invoices = await Invoice.find(q)
      .populate('space', 'businessName businessType')
      .populate('order', 'deliveryDate')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: invoices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/invoices/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('space', 'businessName businessType email contactName address phone')
      .populate('order', 'deliveryDate notes');
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const lines = await InvoiceLine.find({ invoice: invoice._id });
    res.json({ success: true, data: { ...invoice.toObject(), lines } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// WASTE
// ════════════════════════════════════════════════════════════════════════

router.get('/waste/all', async (req, res) => {
  try {
    const { spaceId, from, to, party } = req.query;
    const q = {};
    if (spaceId) q.space = spaceId;
    if (party) q.party = party;
    if (from || to) {
      q.deliveryDate = {};
      if (from) q.deliveryDate.$gte = new Date(from);
      if (to) q.deliveryDate.$lte = new Date(to);
    }
    const logs = await WasteLog.find(q).populate('space', 'businessName').sort({ deliveryDate: -1 });
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/waste', admin, async (req, res) => {
  try {
    const { spaceId, deliveryDate, menuItemId, quantity, reason, note } = req.body;
    if (!spaceId || !deliveryDate || !menuItemId || !quantity || !reason) {
      return res.status(400).json({ success: false, message: 'spaceId, deliveryDate, menuItemId, quantity and reason required' });
    }
    if (!WASTE_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, message: `reason must be one of: ${WASTE_REASONS.join(', ')}` });
    }
    const item = await PartnerMenuItem.findById(menuItemId).select('name');
    if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });
    const log = await WasteLog.create({
      space: spaceId, deliveryDate: new Date(deliveryDate),
      menuItem: menuItemId, itemName: item.name,
      quantity: Number(quantity), party: 'matter', reason, note: note || '',
      createdById: req.user._id, createdByModel: 'User'
    });
    res.status(201).json({ success: true, data: log });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════════════════════════════

router.get('/reports/consolidated', async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    const spaceStats = await Invoice.aggregate([
      { $match: { type: 'matter', status: 'locked' } },
      { $group: { _id: '$space', totalRevenue: { $sum: '$totalRevenue' }, totalCost: { $sum: '$totalCost' }, totalMargin: { $sum: '$totalMargin' }, count: { $sum: 1 } } },
      { $lookup: { from: 'partners', localField: '_id', foreignField: '_id', as: 'space' } },
      { $unwind: { path: '$space', preserveNullAndEmptyArrays: true } },
      { $project: { spaceName: '$space.businessName', totalRevenue: 1, totalCost: 1, totalMargin: 1, count: 1 } },
      { $sort: { totalRevenue: -1 } }
    ]);

    const wasteQ = {};
    if (from || to) wasteQ.deliveryDate = dateFilter;
    const wasteStats = await WasteLog.aggregate([
      { $match: wasteQ },
      { $group: { _id: { space: '$space', party: '$party' }, totalQty: { $sum: '$quantity' } } },
      { $lookup: { from: 'partners', localField: '_id.space', foreignField: '_id', as: 'spaceInfo' } },
      { $unwind: { path: '$spaceInfo', preserveNullAndEmptyArrays: true } },
      { $project: { party: '$_id.party', spaceName: '$spaceInfo.businessName', totalQty: 1 } }
    ]);

    const topItems = await InvoiceLine.aggregate([
      { $lookup: { from: 'invoices', localField: 'invoice', foreignField: '_id', as: 'inv' } },
      { $unwind: '$inv' },
      { $match: { 'inv.type': 'matter', 'inv.status': 'locked' } },
      { $group: { _id: '$itemName', totalQty: { $sum: '$quantity' }, totalRevenue: { $sum: '$lineRevenue' }, totalCost: { $sum: '$lineCost' }, totalMargin: { $sum: '$lineMargin' } } },
      { $sort: { totalQty: -1 } },
      { $limit: 20 }
    ]);

    const totals = spaceStats.reduce((acc, s) => {
      acc.revenue += s.totalRevenue || 0;
      acc.cost += s.totalCost || 0;
      acc.margin += s.totalMargin || 0;
      acc.invoices += s.count || 0;
      return acc;
    }, { revenue: 0, cost: 0, margin: 0, invoices: 0 });

    res.json({ success: true, data: { totals, spaceStats, wasteStats, topItems } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/reports/space/:spaceId', async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    const invoices = await Invoice.find({ space: req.params.spaceId, type: 'matter', status: 'locked' })
      .populate('order', 'deliveryDate').sort({ createdAt: -1 });

    const totals = invoices.reduce((a, i) => ({
      revenue: a.revenue + i.totalRevenue,
      cost: a.cost + i.totalCost,
      margin: a.margin + i.totalMargin
    }), { revenue: 0, cost: 0, margin: 0 });

    const topItems = await InvoiceLine.aggregate([
      { $match: { invoice: { $in: invoices.map(i => i._id) } } },
      { $group: { _id: '$itemName', totalQty: { $sum: '$quantity' }, totalRevenue: { $sum: '$lineRevenue' } } },
      { $sort: { totalQty: -1 } },
      { $limit: 10 }
    ]);

    const wasteQ = { space: req.params.spaceId };
    if (from || to) wasteQ.deliveryDate = dateFilter;
    const waste = await WasteLog.find(wasteQ).sort({ deliveryDate: -1 });

    const orderCounts = await SpaceOrder.aggregate([
      { $match: { space: new mongoose.Types.ObjectId(req.params.spaceId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    res.json({ success: true, data: { totals, invoiceCount: invoices.length, invoices, topItems, waste, orderCounts } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Partner profile picture upload ──────────────────────────────────────────
// Not scoped to :id — the picture can be chosen while still filling in the
// "Add Space" form, before the partner exists. The client uploads first and
// attaches the returned URL to the create/update payload as `profilePicture`.
//
// Uses the raw S3 client + an explicit public-read ACL (same as
// /api/upload/delivery-photo) rather than config/spaces.js's getUploadToSpaces
// (multer-s3), which never sets an ACL — objects it uploads land private, so
// the public CDN URL 403s and the picture never displays.
const partnerPicturesDir = path.join(process.cwd(), 'uploads', 'partners');
const ensurePartnerPicturesDir = () => {
  if (!fs.existsSync(partnerPicturesDir)) fs.mkdirSync(partnerPicturesDir, { recursive: true });
};
const localPartnerPictureUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { ensurePartnerPicturesDir(); cb(null, partnerPicturesDir); },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `partner-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    return cb(new Error('Only image files are allowed!'), false);
  }
});
const memoryPartnerPictureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    return cb(new Error('Only image files are allowed!'), false);
  }
});

router.post('/upload-picture', admin, (req, res, next) => {
  const useSpaces = Boolean(process.env.SPACES_KEY && process.env.SPACES_SECRET && process.env.SPACES_BUCKET);
  const upload = useSpaces ? memoryPartnerPictureUpload : localPartnerPictureUpload;

  upload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Image is too large. Maximum size is 3MB.' });
    }
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const useSpaces = Boolean(process.env.SPACES_KEY && process.env.SPACES_SECRET && process.env.SPACES_BUCKET);
    if (!useSpaces) {
      return res.json({ success: true, url: `${req.protocol}://${req.get('host')}/uploads/partners/${req.file.filename}` });
    }

    const s3 = getS3Client();
    if (!s3) {
      return res.status(503).json({ success: false, message: 'DigitalOcean Spaces is not configured.' });
    }

    const ext = (path.extname(req.file.originalname || '') || '.jpg').toLowerCase();
    const key = `partners/partner-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const uploadParams = {
      Bucket: process.env.SPACES_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'image/jpeg',
    };

    try {
      await s3.send(new PutObjectCommand({ ...uploadParams, ACL: 'public-read' }));
    } catch (aclErr) {
      const code = aclErr?.Code || aclErr?.code || aclErr?.$metadata?.httpStatusCode;
      const isAclError = ['AccessControlListNotSupported', 'AccessDenied', 'InvalidArgument'].includes(String(code))
        || String(aclErr.message).toLowerCase().includes('acl');
      if (isAclError) {
        console.warn('⚠️  ACL upload failed for partner picture, retrying without ACL:', aclErr.message);
        await s3.send(new PutObjectCommand(uploadParams));
      } else {
        throw aclErr;
      }
    }

    const cdnBase = process.env.SPACES_CDN_URL?.replace(/\/$/, '');
    const endpoint = process.env.SPACES_ENDPOINT?.replace(/^https?:\/\//, '');
    const url = cdnBase ? `${cdnBase}/${key}` : `https://${process.env.SPACES_BUCKET}.${endpoint}/${key}`;

    res.json({ success: true, url });
  } catch (err) {
    console.error('Partner picture upload error:', err);
    res.status(500).json({ success: false, message: 'Upload failed. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// PARTNERS (Spaces) — literal routes above, parameterized below
// ════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const q = {};
    if (search) { const re = new RegExp(search, 'i'); q.$or = [{ businessName: re }, { email: re }, { contactName: re }]; }
    const total = await Partner.countDocuments(q);
    const partners = await Partner.find(q).sort({ createdAt: -1 }).skip((Number(page) - 1) * Number(limit)).limit(Number(limit));
    res.json({ success: true, data: partners, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', admin, async (req, res) => {
  try {
    const { email, password, businessName, businessType, contactName, phone, address, menuSelectionEnabled, presetMacros, profilePicture } = req.body;
    if (!email || !password || !businessName || !businessType || !contactName) {
      return res.status(400).json({ success: false, message: 'email, password, businessName, businessType and contactName are required' });
    }
    const exists = await Partner.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(400).json({ success: false, message: 'A partner with this email already exists' });
    const partner = await Partner.create({
      email: email.toLowerCase().trim(), password, businessName, businessType, contactName,
      phone: phone || '', address: address || '', createdBy: req.user._id,
      menuSelectionEnabled: !!menuSelectionEnabled,
      presetMacros: presetMacros || undefined,
      accountCategory: ['retail','member','partner'].includes(req.body.accountCategory) ? req.body.accountCategory : 'partner',
      profilePicture: profilePicture || ''
    });
    partner.password = undefined;
    // New partner should already have every Menu Selection chicken/beef/fish
    // item, not just whatever's been manually assigned since.
    assignMenuSelectionItemsToPartner(partner._id)
      .catch((err) => console.error('[menu-selection->partner-menu sync] new-partner assign failed:', err.message));
    res.status(201).json({ success: true, data: partner });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ success: false, message: 'Partner not found' });
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/:id', admin, async (req, res) => {
  try {
    const allowed = ['businessName', 'businessType', 'contactName', 'phone', 'address', 'isActive', 'minimumOrder', 'menuSelectionEnabled', 'presetMacros', 'profilePicture', 'accountCategory'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    const partner = await Partner.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true });
    if (!partner) return res.status(404).json({ success: false, message: 'Partner not found' });
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete('/:id', admin, async (req, res) => {
  try {
    const partner = await Partner.findByIdAndDelete(req.params.id);
    if (!partner) return res.status(404).json({ success: false, message: 'Partner not found' });
    res.json({ success: true, message: 'Partner deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /:id/menu — items assigned to this space with prices + COGS
router.get('/:id/menu', async (req, res) => {
  try {
    const spaceObjId = new mongoose.Types.ObjectId(req.params.id);
    const assignments = await SpaceMenu.find({ space: req.params.id }).populate('menuItem');

    const currentPrices = await SpacePrice.aggregate([
      { $match: { space: spaceObjId, effectiveFrom: { $lte: new Date() } } },
      { $sort: { menuItem: 1, effectiveFrom: -1 } },
      { $group: { _id: '$menuItem', price: { $first: '$price' } } }
    ]);
    const priceMap = {};
    currentPrices.forEach(p => { priceMap[String(p._id)] = p.price; });

    const currentCosts = await ItemCost.aggregate([
      { $match: { effectiveFrom: { $lte: new Date() } } },
      { $sort: { menuItem: 1, effectiveFrom: -1 } },
      { $group: { _id: '$menuItem', cost: { $first: '$cost' } } }
    ]);
    const costMap = {};
    currentCosts.forEach(c => { costMap[String(c._id)] = c.cost; });

    const data = assignments.map(a => ({
      _id: a._id,
      isActive: a.isActive,
      menuItem: a.menuItem,
      price: priceMap[String(a.menuItem?._id)] ?? a.menuItem?.sellingPrice ?? null,
      cost: costMap[String(a.menuItem?._id)] ?? null
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /:id/menu — assign item to space, optionally set price + COGS
router.post('/:id/menu', async (req, res) => {
  try {
    const { menuItemId, price, cost } = req.body;
    if (!menuItemId) return res.status(400).json({ success: false, message: 'menuItemId required' });
    await SpaceMenu.findOneAndUpdate(
      { space: req.params.id, menuItem: menuItemId },
      { isActive: true },
      { upsert: true, new: true }
    );
    if (price !== undefined) {
      await SpacePrice.create({ space: req.params.id, menuItem: menuItemId, price: Number(price) });
    }
    if (cost !== undefined) {
      await ItemCost.create({ menuItem: menuItemId, cost: Number(cost) });
    }
    res.status(201).json({ success: true, message: 'Item assigned to space' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /:id/menu/:menuItemId — remove item from space (soft)
router.delete('/:id/menu/:menuItemId', async (req, res) => {
  try {
    await SpaceMenu.findOneAndUpdate(
      { space: req.params.id, menuItem: req.params.menuItemId },
      { isActive: false }
    );
    res.json({ success: true, message: 'Item removed from space menu' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /:id/orders
router.get('/:id/orders', async (req, res) => {
  try {
    const orders = await SpaceOrder.find({ space: req.params.id }).sort({ deliveryDate: -1 });
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/partners/:id/members — members of a partner + their order counts
router.get('/:id/members', async (req, res) => {
  try {
    const members = await Member.find({ partner: req.params.id }).sort({ createdAt: -1 });
    const counts = await MemberOrder.aggregate([
      { $match: { partner: new mongoose.Types.ObjectId(req.params.id) } },
      { $group: { _id: '$member', count: { $sum: 1 } } }
    ]);
    const countMap = {};
    counts.forEach(c => { countMap[String(c._id)] = c.count; });
    res.json({
      success: true,
      data: members.map(m => ({ ...m.toObject(), orderCount: countMap[String(m._id)] || 0 }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/admin/partners/:id/members/:memberId — activate / deactivate a member
router.patch('/:id/members/:memberId', admin, async (req, res) => {
  try {
    const { isActive } = req.body;
    const member = await Member.findOneAndUpdate(
      { _id: req.params.memberId, partner: req.params.id },
      { isActive },
      { new: true }
    );
    if (!member) return res.status(404).json({ success: false, message: 'Member not found' });
    res.json({ success: true, data: member });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
