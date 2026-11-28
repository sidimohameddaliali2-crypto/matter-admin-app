import { MATTER_IMPORT_IDENTITIES } from '../config/matterImportIdentity.js';

const protectedNames = new Set(MATTER_IMPORT_IDENTITIES.map(([field]) => field));
protectedNames.add('matterBookingObservations');
const protectedPath = value => String(value).split('.').some(part => protectedNames.has(part));

export function removeClientMatterImportIdentity(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (protectedPath(key)) { delete value[key]; continue; }
    if (key === '$rename' && value[key] && typeof value[key] === 'object') {
      for (const [source, destination] of Object.entries(value[key])) {
        if (protectedPath(source) || protectedPath(destination)) delete value[key][source];
      }
    }
    removeClientMatterImportIdentity(value[key]);
  }
}

export function protectMatterImportIdentityInput(req, _res, next) {
  removeClientMatterImportIdentity(req.body);
  next();
}
