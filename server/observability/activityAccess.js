import { readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const activityReadersFile = () => process.env.MATTER_ACTIVITY_READERS_FILE ||
  fileURLToPath(new URL('../.private/activity-history/readers.json', import.meta.url));

export function configuredActivityReaders({ file = activityReadersFile() } = {}) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (info.mode & 0o077) ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) return [];
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (config.version !== 1 || !Array.isArray(config.readerIds) || config.readerIds.length !== 1 ||
      config.readerIds.some(id => !/^[a-f\d]{24}$/.test(id)) ||
      new Set(config.readerIds).size !== config.readerIds.length) return [];
    return config.readerIds;
  } catch { return []; }
}

// Membership comes only from the private release configuration. Roles, email,
// browser flags and editable permission fields never grant history access.
export function hasActivityHistoryAccess(user, options) {
  if (!user || user.isActive !== true) return false;
  const id = String(user._id || user.id || '');
  return configuredActivityReaders(options).includes(id);
}

export function requireActivityHistoryReader(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Sign in to continue.' });
  if (!hasActivityHistoryAccess(req.user))
    return res.status(403).json({ success: false, message: 'This history is private to its approved account.' });
  next();
}
