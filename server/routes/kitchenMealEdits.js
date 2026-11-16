import express from 'express';
import { effectivePermissions } from '../models/User.js';
import { readMealEditContext, mealEditView, editKitchenMeals, readMealEditLog } from '../services/kitchenMealEdits.js';

const router = express.Router({ mergeParams: true });
router.use((req, res, next) => {
  if (!effectivePermissions(req.user).kitchen_list) return res.status(403).json({ success: false, message: 'Kitchen List permission is required.' });
  next();
});
const handle = task => async (req, res) => {
  try { res.json({ success: true, data: await task(req) }); }
  catch (error) { res.status(error.code === 11000 ? 409 : error.statusCode || 500).json({ success: false,
    message: error.code === 11000 ? 'Selections changed during editing. Reload before saving.' : error.message }); }
};
router.get('/meal-editor', handle(async req => mealEditView(await readMealEditContext(req.params.id, req.params.customerId, req.query.date))));
router.post('/meal-editor', handle(req => editKitchenMeals({ menuId: req.params.id, customerId: req.params.customerId,
  date: req.body.date, body: req.body, user: req.user })));
router.get('/meal-log', handle(req => readMealEditLog({ menuId: req.params.id, customerId: req.params.customerId, before: req.query.before })));
export default router;
