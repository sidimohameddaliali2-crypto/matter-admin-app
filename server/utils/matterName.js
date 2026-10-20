// Owner (2026-10-16): the delivery sheet and the kitchen sheet must show the
// SAME customer name — the one on the Matter API subscription — not the
// internal Customer record's name (which can be misspelled, differ from
// Matter's, or be missing).
//
// Matter's names are sometimes typed all-lowercase or ALL CAPS; only those get
// tidied to Title Case, a mixed-case name is kept exactly as Matter has it.
// client/src/lib/kitchenData.js (getCustomerName) applies the same rule, so
// the kitchen paper and the delivery sheet always agree.
export function displayMatterName(rawName) {
  const name = String(rawName ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return '';
  const allOneCase = name === name.toLowerCase() || name === name.toUpperCase();
  if (!allOneCase) return name;
  return name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}
