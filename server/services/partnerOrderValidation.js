import mongoose from 'mongoose';
import SpaceMenu from '../models/SpaceMenu.js';
import SpacePrice from '../models/SpacePrice.js';

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export const normalizePartnerLines = (lines) => {
  if (!Array.isArray(lines)) throw invalid('lines must be an array');
  const seen = new Set();
  return lines.map((line) => {
    const id = line?.menuItemId;
    const quantity = typeof line?.quantity === 'number' || typeof line?.quantity === 'string'
      ? Number(line.quantity) : NaN;
    if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) throw invalid('Invalid menu item ID.');
    if ((typeof line?.quantity === 'string' && !line.quantity.trim()) || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw invalid('Quantities must be non-negative whole numbers.');
    }
    const menuItemId = id.toLowerCase();
    if (seen.has(menuItemId)) throw invalid('Each menu item must appear only once.');
    seen.add(menuItemId);
    return { menuItemId, quantity };
  });
};

// Delivery dates and item availability are calendar dates stored at UTC midnight.
export const isPartnerItemAvailable = (item, deliveryDate) => {
  if (!item || item.isAvailable === false) return false;
  const day = new Date(deliveryDate).setUTCHours(0, 0, 0, 0);
  if (item.availableFrom && day < new Date(item.availableFrom).setUTCHours(0, 0, 0, 0)) return false;
  if (item.availableTo && day > new Date(item.availableTo).setUTCHours(0, 0, 0, 0)) return false;
  return true;
};

export const partnerUnitPrice = (item, override) => Number(override ?? item?.sellingPrice ?? item?.price ?? 0);

// Validate the complete proposed order before changing any stored lines.
export const validatePartnerOrder = async ({ spaceId, deliveryDate, lines, minimumOrder = 0, requireItems = false }) => {
  const positive = lines.filter(l => l.quantity > 0);
  if (requireItems && !positive.length) throw invalid('Order has no items.');
  if (!positive.length) return { pricedLines: [], totalAmount: 0 };
  const ids = positive.map(l => l.menuItemId);
  const assignments = await SpaceMenu.find({ space: spaceId, isActive: true, menuItem: { $in: ids } }).populate('menuItem');
  const items = new Map(assignments.filter(a => a.menuItem).map(a => [String(a.menuItem._id), a.menuItem]));
  for (const line of positive) {
    if (!isPartnerItemAvailable(items.get(line.menuItemId), deliveryDate)) {
      throw invalid('An order item is unavailable for this delivery date or is not assigned to your menu.');
    }
  }
  const prices = await SpacePrice.aggregate([
    { $match: { space: new mongoose.Types.ObjectId(String(spaceId)), menuItem: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) }, effectiveFrom: { $lte: new Date() } } },
    { $sort: { menuItem: 1, effectiveFrom: -1 } },
    { $group: { _id: '$menuItem', price: { $first: '$price' } } }
  ]);
  const overrides = new Map(prices.map(p => [String(p._id), p.price]));
  const pricedLines = positive.map(l => ({
    menuItem: items.get(l.menuItemId), quantity: l.quantity,
    unitPrice: partnerUnitPrice(items.get(l.menuItemId), overrides.get(l.menuItemId))
  }));
  const totalAmount = pricedLines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  if (minimumOrder > 0 && totalAmount < minimumOrder) {
    throw invalid(`Minimum order is AED ${Number(minimumOrder).toFixed(2)}. Current total: AED ${totalAmount.toFixed(2)}.`);
  }
  return { pricedLines, totalAmount };
};
