import { createHash } from 'node:crypto';

const normalize = value => typeof value === 'string' && value.length <= 2048
  ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';

// Only explicit, unconditional instructions on the dated address qualify.
// General access notes and third-party handoffs carry no placement approval.
const placement = [
  ['door', /^(?:please )?(?:leave|place|drop(?: off)?) (?:it |the (?:bag|order) )?(?:at|on|by) (?:the )?(?:(?:front |apartment |villa )?door|doorstep)[.!]?$/],
  ['gate', /^(?:please )?(?:leave|place|drop(?: off)?) (?:it |the (?:bag|order) )?(?:at|on|by) (?:the )?(?:front |villa )?gate[.!]?$/],
  ['reception_shelf', /^(?:please )?(?:leave|place|drop(?: off)?) (?:it |the (?:bag|order) )?(?:on|at) (?:the )?reception shelf[.!]?$/],
];
const placementLanguage = /\b(?:leave|place|drop|deliver|hand|put|give|receive|reception|concierge|security desk|side (?:gate|entrance|door)|back (?:gate|entrance|door)|locker)\b/;

export function reportingPhotoInstructions(address, savedAddress) {
  const notes = [...new Set([address?.additionalDetails, address?.additional_details].map(normalize).filter(Boolean))].sort();
  const isVilla = [address?.locationType, address?.sourceCategory].some(value => normalize(value) === 'villa');
  const villaNumber = isVilla && /^villa ([a-z0-9]+(?:-[a-z0-9]+)*)(?:,(?!.*\bvilla\s).*)?$/.exec(normalize(savedAddress))?.[1];
  const verifiedVillaNumber = villaNumber && villaNumber.length <= 24 && /[0-9]/.test(villaNumber)
    ? villaNumber.toUpperCase() : null;
  if (!notes.length && !verifiedVillaNumber) return null;
  const approvedPlace = notes.length === 1
    ? placement.find(([, match]) => match.test(notes[0]))?.[0] ?? null : null;
  const placementUncertain = !approvedPlace && notes.some(note => placementLanguage.test(note));
  return { approvedPlace,
    instructionSha256: notes.length ? createHash('sha256').update(JSON.stringify(notes)).digest('hex') : null,
    ...(placementUncertain && { placementUncertain }),
    ...(verifiedVillaNumber && { verifiedVillaNumber }) };
}
