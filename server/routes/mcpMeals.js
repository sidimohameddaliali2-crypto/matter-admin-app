import express from 'express';
import { protect } from '../middleware/auth.js';
import { effectivePermissions } from '../models/User.js';
import { createMcpMealReader } from '../services/matterMcpMeals.js';

export function createMcpMealsRouter({ authenticate = protect, reader = createMcpMealReader() } = {}) {
  const router = express.Router();
  router.use(authenticate, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    req.mealPermissions = effectivePermissions(req.user);
    if (!req.mealPermissions.menus && !req.mealPermissions.kitchen_list) return res.status(403).json({ success: false, message: 'Menu or kitchen-list permission is required' });
    next();
  });
  const run = handler => async (req, res) => {
    try { res.json({ success: true, data: await handler(req) }); }
    catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Meal data could not be read' }); }
  };
  router.get('/menus', run(req => reader.dailyMenu({ date: req.query.date, menuId: req.query.menuId })));
  router.get('/selections', (req, res, next) => {
    if (!req.mealPermissions.customers) return res.status(403).json({ success: false, message: 'Customer permission is required to read meal selections' });
    next();
  }, run(req => reader.customerMeals({ date: req.query.date, menuId: req.query.menuId,
    email: req.query.email, matterCustomerId: req.query.matterCustomerId, includeKitchen: req.mealPermissions.kitchen_list === true })));
  return router;
}

export default createMcpMealsRouter();
