import crypto from 'node:crypto';
import WeeklyMenu from '../models/WeeklyMenu.js';

export const createShortMenuToken = () => crypto.randomBytes(12).toString('base64url');
export const menuShareFilter = token => ({ $or: [{ 'shareLink.token': token }, { 'shareLink.shortToken': token }] });

// Add a stable alias without rotating the existing token or invalidating sent links.
export async function ensureShortMenuToken(menu, { Model = WeeklyMenu, makeToken = createShortMenuToken } = {}) {
  if (menu.shareLink?.shortToken) return menu.shareLink.shortToken;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const updated = await Model.findOneAndUpdate({ _id: menu._id,
        $or: [{ 'shareLink.shortToken': { $exists: false } }, { 'shareLink.shortToken': null }, { 'shareLink.shortToken': '' }],
      }, { $set: { 'shareLink.shortToken': makeToken() } }, { new: true, timestamps: false });
      const current = updated || await Model.findById(menu._id);
      if (!current) throw new Error('Menu not found');
      if (current.shareLink?.shortToken) return current.shareLink.shortToken;
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  throw new Error('Unable to create the short menu link. Please try again.');
}
