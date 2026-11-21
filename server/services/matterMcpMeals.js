import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import MenuSelectionArchive from '../models/MenuSelectionArchive.js';
import { Types } from 'mongoose';
import { excludeRecreatedArchivedAliases } from './archivedMenuAliases.js';
import { isDateKey } from '../utils/businessDate.js';
import { menuDateKey as dateKey } from './kitchenMenuDates.js';

const problem = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const identifier = value => /^[a-f0-9]{24}$/i.test(value || '');
const idOf = value => value ? String(value._id || value) : null;
const atDate = (map, date) => map instanceof Map ? map.get(date) : map?.[date];
const menuFields = 'title startDate endDate isActive isPublished meals mainMealOptionsByDate breakfastOptionsByDate snackOptionsByDate matterCoreMealOptionsByDate';
const itemFields = '_id mealName mealType description mealPlan proteinSource veg sauce garnish portionType rotationCategory usedForCorePlan image calories protein carbs fat';
const validate = (date, menuId) => {
  if (!isDateKey(date)) throw problem(400, 'Provide a valid menu date as YYYY-MM-DD');
  if (menuId !== undefined && !identifier(menuId)) throw problem(400, 'Invalid weekly menu ID');
};
const coversDate = (menu, date) => (dateKey(menu.startDate) <= date && dateKey(menu.endDate) >= date)
  || (menu.meals || []).some(meal => dateKey(meal.date) === date)
  || ['mainMealOptionsByDate', 'breakfastOptionsByDate', 'snackOptionsByDate', 'matterCoreMealOptionsByDate']
    .some(field => atDate(menu[field], date) !== undefined);
const summary = menu => ({ menuId: idOf(menu), title: menu.title, startDate: dateKey(menu.startDate), endDate: dateKey(menu.endDate),
  isActive: menu.isActive, isPublished: menu.isPublished });

export function createMcpMealReader({ menus = WeeklyMenu, selections = MenuSelectionRecord, archives = MenuSelectionArchive } = {}) {
  const loadMenu = async (menuId, date) => {
    if (!identifier(menuId)) throw problem(400, 'Provide an exact weekly menu ID');
    validate(date, menuId);
    const menu = await menus.findById(menuId).select(menuFields).lean();
    if (!menu) throw problem(404, 'Weekly menu not found');
    if (!coversDate(menu, date)) throw problem(400, 'The requested date is outside this weekly menu');
    return menu;
  };
  return {
    async dailyMenu({ date, menuId }) {
      validate(date, menuId);
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(+start + 86400000);
      const filter = menuId ? { _id: menuId } : { isActive: true, $or: [
        { startDate: { $lt: end }, endDate: { $gte: start } },
        { 'meals.date': { $gte: start, $lt: end } },
        ...['mainMealOptionsByDate', 'breakfastOptionsByDate', 'snackOptionsByDate', 'matterCoreMealOptionsByDate']
          .map(field => ({ [`${field}.${date}`]: { $exists: true } })),
      ] };
      const found = await menus.find(filter).select(menuFields).populate('meals.items', itemFields)
        .sort({ startDate: -1, _id: 1 }).limit(21).lean();
      if (found.length > 20) throw problem(409, 'Too many matching menus. Supply an exact weekly menu ID');
      const matching = found.filter(menu => coversDate(menu, date));
      if (menuId && !matching.length) throw problem(404, 'No menu for that ID and date');
      return { date, found: matching.length > 0, requiresMenuChoice: matching.length > 1,
        menus: matching.map(menu => ({ ...summary(menu), date,
          meals: (menu.meals || []).filter(meal => dateKey(meal.date) === date).map(meal => ({
            mealType: meal.mealType,
            items: (meal.items || []).filter(item => item && typeof item === 'object' && item.mealName).map(item => ({ ...item, _id: idOf(item) })),
          })),
          mainMealOptions: atDate(menu.mainMealOptionsByDate, date) || null,
          breakfastOptions: atDate(menu.breakfastOptionsByDate, date) || [],
          snackOptions: atDate(menu.snackOptionsByDate, date) || null,
          matterCoreMealOptions: atDate(menu.matterCoreMealOptionsByDate, date) || [],
        })) };
    },
    async customerMeals({ date, menuId, email, matterCustomerId, includeKitchen = false }) {
      const menu = await loadMenu(menuId, date);
      if ((!!email === !!matterCustomerId) || (email && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())))
        || (matterCustomerId && (typeof matterCustomerId !== 'string' || !matterCustomerId.trim() || matterCustomerId.length > 100))) {
        throw problem(400, 'Supply exactly one website email or permanent Matter customer ID');
      }
      const normalizedEmail = email?.trim().toLowerCase();
      const exactEmail = normalizedEmail ? new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null;
      const filter = { weeklyMenuId: menuId, ...(matterCustomerId ? { matterCustomerId: matterCustomerId.trim() } : {
        $or: [{ matterEmail: exactEmail }, { matterEmail: { $in: [null, ''] }, matterCustomerId: { $in: [null, ''] }, email: exactEmail }],
      }) };
      const rows = await selections.find(filter).select('weeklyMenuId email matterEmail matterCustomerId firstName lastName selectedMeals skippedDays dayNotes submittedAt updatedAt')
        .populate('selectedMeals.menuItemId', '_id mealName mealType description').limit(21).lean();
      if (rows.length > 20) throw problem(409, 'Ambiguous selection identity. Use the permanent Matter customer ID');
      const aliases = rows.filter(row => !row.matterCustomerId).map(row => row.email);
      const archived = aliases.length ? await archives.find({ 'original.weeklyMenuId': new Types.ObjectId(menuId), 'original.email': { $in: aliases } }).lean() : [];
      if (archived.some(archive => !rows.some(row => idOf(row) === idOf(archive.retainedSelectionId)))) {
        throw problem(409, 'This legacy selection identity was reconciled. Use the permanent Matter customer ID');
      }
      const matches = excludeRecreatedArchivedAliases(rows, archived);
      if (matches.length > 1) throw problem(409, 'More than one selection account matches. Use the permanent Matter customer ID or resolve the duplicate accounts');
      if (!matches.length) return { date, menu: summary(menu), found: false, customerSelections: [],
        message: 'No saved selection record matches this identity and weekly menu. No choices have been inferred.' };
      const row = matches[0];
      const forDate = (row.selectedMeals || []).filter(meal => dateKey(meal.date) === date);
      const project = meal => ({ date, source: meal.isAutoAssigned === true ? 'kitchen_assignment' : 'customer_selection',
        mealType: meal.mealType, menuItemId: idOf(meal.menuItemId),
        mealName: meal.mealName || meal.menuItemId?.mealName || null,
        description: meal.description || meal.menuItemId?.description || null,
        slotNumber: meal.slotNumber, quantity: meal.quantity ?? 1,
        proteinChoice: meal.proteinChoice, vegChoice: meal.vegChoice, carbChoice: meal.carbChoice, sauceChoice: meal.sauceChoice,
        ...(includeKitchen ? { remark: meal.remark, exclusionConflict: meal.exclusionConflict,
          needsSauceChange: meal.needsSauceChange, needsGarnishChange: meal.needsGarnishChange } : {}),
      });
      return { date, menu: summary(menu), found: true,
        identity: { matterCustomerId: row.matterCustomerId || null, email: row.matterEmail || row.email,
          emailSource: row.matterEmail ? 'matter_website_email' : 'legacy_selection_email' },
        submittedAt: row.submittedAt, updatedAt: row.updatedAt,
        customerSelections: forDate.filter(meal => meal.isAutoAssigned !== true).map(project),
        skippedDays: (row.skippedDays || []).filter(day => day.date === date).map(day => ({
          date: day.date, pauseStatus: day.pauseStatus, resumeDate: day.resumeDate, resumedAt: day.resumedAt,
        })),
        ...(includeKitchen ? { kitchenAssignments: forDate.filter(meal => meal.isAutoAssigned === true).map(project),
          dayNotes: (row.dayNotes || []).filter(note => note.date === date).map(note => ({ date: note.date, note: note.note })) } : {}),
      };
    },
  };
}
