import MenuSelectionRecord from '../models/MenuSelectionRecord.js';

export const appendKitchenMeals = async (menuId, email, record, update) => {
  const filter = {
    weeklyMenuId: menuId, email,
    ...(record?._id ? { _id: record._id } : {}),
    selectedMeals: record ? (record.selectedMeals || []) : { $size: 0 },
    ...(record ? { $expr: { $eq: [{ $ifNull: ['$skippedDays', []] }, record.skippedDays || []] } } : {}),
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
