// Automatic zone overrides, applied to every Delivery on create/edit
// (see the Delivery model's hooks). Owner, 2026-10-12:
//   - a delivery whose emirate (addressDetails.city) is Abu Dhabi gets
//     zone "Abu Dhabi", whatever sub-area the address matched; and
//   - a delivery whose zone is "Dubai South" gets zone "Abu Dhabi".
// Add further rules here, not at individual call sites.

export const ABU_DHABI_ZONE = 'Abu Dhabi';

// Matter's emirate sometimes carries a sub-area suffix ("Abu Dhabi - Al Reem
// Island") and inconsistent casing ("Abu dhabi", "ABU DHABI").
export const isAbuDhabiEmirate = (city) => /^\s*abu\s*dhabi\b/i.test(String(city || ''));

const isDubaiSouthZone = (zone) => /^\s*dubai\s+south\s*$/i.test(String(zone || ''));

// Returns the zone this delivery should have: ABU_DHABI_ZONE when a rule
// matches, otherwise the zone unchanged.
export function applyZoneRules({ zone, city }) {
  if (isAbuDhabiEmirate(city)) return ABU_DHABI_ZONE;
  if (isDubaiSouthZone(zone)) return ABU_DHABI_ZONE;
  return zone;
}
