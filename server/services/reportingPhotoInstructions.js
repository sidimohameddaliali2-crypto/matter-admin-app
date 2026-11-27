import { createHash } from 'node:crypto';

const maxInstructionLength = 2048;
const normalize = value => typeof value === 'string' && value.length <= maxInstructionLength
  ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
const digest = value => createHash('sha256').update(value).digest('hex');

// Only explicit, unconditional instructions on the dated address qualify.
// General access notes and third-party handoffs carry no placement approval.
const placement = [
  ['door', /^(?:please )?(?:leave|place|drop(?: off)?) (?:it |the (?:bag|order) )?(?:at|on|by) (?:the )?(?:(?:front |apartment |villa )?door|doorstep)[.!]?$/],
  ['gate', /^(?:please )?(?:leave|place|drop(?: off)?) (?:it |the (?:bag|order) )?(?:at|on|by) (?:the )?(?:front |villa )?gate[.!]?$/],
  ['reception_shelf', /^(?:please )?(?:leave|place|drop(?: off)?) (?:it |the (?:bag|order) )?(?:on|at) (?:the )?reception shelf[.!]?$/],
];
const accessCode = /^(?:(?:gate|door|building|entry|intercom|buzzer|access) (?:code|pin)|pin|passcode|(?:رمز|كود) (?:الدخول|الباب|البوابة))(?: is)?(?: +| *[:=] *)(#?[\p{L}\p{N}*#-]{1,24})[.!]?$/u;

function isAccessOnly(note) {
  const code = accessCode.exec(note)?.[1];
  return code !== undefined && /\p{N}/u.test(code);
}

export function reportingPhotoInstructions(address, savedAddress) {
  const values = [address?.additionalDetails, address?.additional_details];
  const notes = [...new Set(values.map(normalize).filter(Boolean))].sort();
  const oversized = [...new Set(values.filter(value => typeof value === 'string' && value.length > maxInstructionLength)
    .map(digest))].sort();
  const isVilla = [address?.locationType, address?.sourceCategory].some(value => normalize(value) === 'villa');
  const villaNumber = isVilla && /^villa ([a-z0-9]+(?:-[a-z0-9]+)*)(?:,(?!.*\bvilla\s).*)?$/.exec(normalize(savedAddress))?.[1];
  const verifiedVillaNumber = villaNumber && villaNumber.length <= 24 && /[0-9]/.test(villaNumber)
    ? villaNumber.toUpperCase() : null;
  if (!notes.length && !oversized.length && !verifiedVillaNumber) return null;
  const approvedPlace = notes.length === 1 && !oversized.length
    ? placement.find(([, match]) => match.test(notes[0]))?.[0] ?? null : null;
  // Free-form directions may contradict the default entrance, even in a different language.
  const placementUncertain = !approvedPlace && (oversized.length > 0 || notes.some(note => !isAccessOnly(note)));
  const noteIdentity = oversized.length ? { notes, oversized } : notes;
  return { approvedPlace,
    instructionSha256: notes.length || oversized.length ? digest(JSON.stringify(noteIdentity)) : null,
    ...(placementUncertain && { placementUncertain }),
    ...(verifiedVillaNumber && { verifiedVillaNumber }) };
}
