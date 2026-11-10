import { protect } from './auth.js';
import { effectivePermissions } from '../models/User.js';
import WeeklyMenu from '../models/WeeklyMenu.js';
import { normalizeMenuEmail, verifyMenuSession } from '../services/menuCustomerAuth.js';

// The API must enforce the same configured permissions as the staff pages.
export const menuStaffAccess = (...keys) => [protect, (req, res, next) => {
  const permissions = effectivePermissions(req.user);
  if (!keys.some(key => permissions[key])) {
    return res.status(403).json({ success: false, message: 'Customer access is not permitted for this staff account.' });
  }
  next();
}];

export const customerProfileRead = menuStaffAccess('customers', 'website_subscriptions', 'subscription', 'menus', 'kitchen_list', 'kitchen_counting');
export const customerProfileWrite = menuStaffAccess('customers');

export async function activeCustomerMenu(menuId, token) {
  if (!/^[a-f\d]{24}$/i.test(String(menuId || ''))) throw Object.assign(new Error('A valid menu is required.'), { statusCode: 400 });
  const menu = await WeeklyMenu.findOne({
    _id: menuId, isActive: { $ne: false }, isPublished: true,
    'shareLink.isActive': true,
    ...(token ? { 'shareLink.token': token } : {}),
    $or: [{ 'shareLink.expiresAt': null }, { 'shareLink.expiresAt': { $gt: new Date() } }],
  }).select('_id meals shareLink').populate({ path: 'meals.items', select: 'mealName' }).lean();
  if (!menu) throw Object.assign(new Error('This menu link is no longer available.'), { statusCode: 410 });
  return menu;
}

export const customerMenuAccess = async (req, res, next) => {
  try {
    const claims = verifyMenuSession(req.get('X-Menu-Session'));
    const email = normalizeMenuEmail(req.params.email);
    const reading = req.method === 'GET' || req.method === 'HEAD';
    const menuId = reading ? req.query.menuId : req.body?.weeklyMenuId || req.body?.menuId;
    if (email !== claims.email || String(menuId) !== claims.menuId ||
        (req.query?.email && normalizeMenuEmail(req.query.email) !== claims.email)) {
      return res.status(403).json({ success: false, message: 'This menu session belongs to a different customer or menu.' });
    }
    if (!reading) {
      const allowed = new Set(req.path.endsWith('/select-meals')
        ? ['weeklyMenuId', 'selections', 'skippedDates', 'matterCustomerId', 'subscriptionId', 'pauseDecisions']
        : ['menuId', 'dates']);
      if (Object.keys(req.body).some(key => !allowed.has(key))) return res.status(400).json({ success: false, message: 'This request contains fields that customers cannot change.' });
    }
    req.customerMenu = await activeCustomerMenu(claims.menuId);
    req.menuCustomer = claims;
    res.set('Cache-Control', 'no-store');
    next();
  } catch (error) {
    res.status(error.statusCode || 401).json({ success: false, message: error.statusCode ? error.message : 'Please enter your email again to continue.' });
  }
};

export function validateCustomerSelections(menu, nutrition, selections) {
  if (!Array.isArray(selections) || selections.length > 200) return 'Select a valid number of meals.';
  const totals = new Map();
  const allowance = Number(nutrition.meal_frequency);
  for (const selection of selections) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return 'Select valid menu items.';
    const quantity = selection.quantity === undefined ? 1 : selection.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) return 'Meal quantities must be positive whole numbers within your plan.';
    const day = String(selection.date || '');
    const type = selection.mealType;
    const row = menu.meals?.find(row => new Date(row.date).toISOString().slice(0, 10) === day && row.mealType === type);
    const item = row?.items?.find(item => String(item._id) === String(selection.menuItemId));
    if (!item) return 'Choose a meal offered on this menu and delivery day.';
    // Names are operational data too: derive them from the offered item.
    selection.mealName = item.mealName;
    if (Array.isArray(nutrition.active_delivery_dates) && !nutrition.active_delivery_dates.includes(day)) return 'This day is not an active delivery day for your subscription.';
    const counts = totals.get(day) || { meals: 0, breakfast: 0, snacks: 0 };
    if (type === 'snack') counts.snacks += quantity;
    else { counts.meals += quantity; if (type === 'breakfast') counts.breakfast += quantity; }
    if (!Number.isSafeInteger(allowance) || allowance < 1) return 'Your meal allowance could not be verified. Please contact customer service.';
    if (counts.meals > allowance || counts.breakfast > (nutrition.breakfast_included ? 1 : 0) || counts.snacks > (Number(nutrition.snacks_per_day) || 0)) return 'The selected meals exceed your subscription allowance.';
    totals.set(day, counts);
  }
  return null;
}

// Staff preview retains its existing permission-checked access. A customer
// session is never accepted by the staff profile editing endpoints above.
export const menuProfileAccess = (req, res, next) => {
  if (req.get('X-Menu-Session')) return customerMenuAccess(req, res, next);
  const [authenticate, permission] = customerProfileRead;
  authenticate(req, res, () => permission(req, res, next));
};
