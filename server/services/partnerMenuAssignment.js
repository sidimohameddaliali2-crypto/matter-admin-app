import Partner from '../models/Partner.js';
import PartnerMenuItem from '../models/PartnerMenuItem.js';
import SpaceMenu from '../models/SpaceMenu.js';

// Owner (2026-10-23): every master-menu item should be available to every
// partner by default, with no manual Space Setup step — an admin can still
// turn one off for a specific partner, and that removal must stick.
//
// This only ever CREATES a missing SpaceMenu row (as active, via
// $setOnInsert). It never touches a row that already exists, so a partner's
// item never gets silently re-enabled after an admin removed it — calling
// this again later (another sync, another partner creation) is always safe.
const ensureAssigned = (spaceId, menuItemId) =>
  SpaceMenu.updateOne(
    { space: spaceId, menuItem: menuItemId },
    { $setOnInsert: { isActive: true } },
    { upsert: true }
  );

// Makes one master-menu item orderable by every currently active partner.
// Call this right after creating a PartnerMenuItem (manually or via a sync).
export const assignItemToAllActivePartners = async (menuItemId) => {
  const partners = await Partner.find({ isActive: true }).select('_id').lean();
  await Promise.all(partners.map((p) => ensureAssigned(p._id, menuItemId)));
};

// Gives one partner (typically a newly created one) every master-menu item
// that already exists, so they aren't missing anything just because they
// signed up after those items were added.
export const assignAllMasterItemsToPartner = async (partnerId) => {
  const items = await PartnerMenuItem.find({ isAvailable: true }).select('_id').lean();
  await Promise.all(items.map((it) => ensureAssigned(partnerId, it._id)));
};
