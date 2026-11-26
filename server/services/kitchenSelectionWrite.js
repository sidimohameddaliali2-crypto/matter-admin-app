import MenuSelectionRecord from '../models/MenuSelectionRecord.js';

// Keep the raw embedded BSON values from a lean read. A typed equality filter
// would cast each meal and add present-day schema defaults to legacy rows.
export const matchSavedMealArray = meals => ({ $eq: [{ $ifNull: ['$selectedMeals', []] }, { $literal: meals || [] }] });
export const matchSavedKitchenInputs = record => ({ $and: [
  matchSavedMealArray(record.selectedMeals),
  { $eq: [{ $ifNull: ['$skippedDays', []] }, { $literal: record.skippedDays || [] }] },
] });

export const appendKitchenMeals = async (menuId, email, record, update) => {
  const filter = {
    weeklyMenuId: menuId, email,
    $nor: [{ kitchenAutoHolds: { $elemMatch: { date: { $in: [...new Set((update.$push?.selectedMeals?.$each || [])
      .filter(meal => meal.date).map(meal => new Date(meal.date).toISOString().slice(0, 10)))] } } } }],
    ...(record?._id ? { _id: record._id } : {}),
    ...(record ? { $expr: matchSavedKitchenInputs(record) } : { selectedMeals: { $size: 0 } }),
  };
  try {
    const saved = await MenuSelectionRecord.findOneAndUpdate(filter, update, { upsert: !record, new: true });
    if (!saved) throw new Error('Selection changed');
    return saved;
  } catch (cause) {
    if (cause.code !== 11000 && cause.message !== 'Selection changed') throw cause;
    const error = new Error(`Meals changed for ${email} during assignment. Retry preparation; existing choices were preserved.`);
    error.statusCode = 409;
    error.code = 'KITCHEN_PREPARATION_BUSY';
    throw error;
  }
};
