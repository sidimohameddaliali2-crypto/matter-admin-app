import { createHash } from 'node:crypto';

const objectId = /^[a-f0-9]{24}$/;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function primaryProofPhoto(proof) {
  const photo = proof?.photoUrl || proof?.images?.[0];
  return typeof photo === 'string' && photo.trim() ? photo : null;
}

function handsetFingerprint(location) {
  const { lat, lng } = location || {};
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && (lat !== 0 || lng !== 0) ? fingerprint([lat, lng]) : null;
}

function photoFingerprint(proof) {
  const photo = primaryProofPhoto(proof);
  const camera = proof?.photoCapturedAt;
  if (!photo || proof.photoSource !== 'camera' || !camera || !Number.isFinite(+new Date(camera))) return null;
  return fingerprint([photo, new Date(camera).toISOString()]);
}

// The caller supplies the authenticated request actor and the location from
// this write. Existing proof.location is never an input to the receipt.
export function captureFleetProofReceipt(delivery, incoming, assignedDriverId, context) {
  const { actor, previousPhoto, previousReceipt, handsetLocation } = context || {};
  const actorId = String(actor?._id ?? actor?.id ?? '');
  const photo = primaryProofPhoto(delivery.proof);
  const photoCaptureSha256 = photoFingerprint(delivery.proof);
  if (actor?.role !== 'driver' || !objectId.test(actorId) || actorId !== assignedDriverId || !photoCaptureSha256
      || photo !== primaryProofPhoto(incoming)) return null;

  const replay = photo === previousPhoto;
  if (replay && (previousReceipt?.actorId !== actorId || previousReceipt.photoCaptureSha256 !== photoCaptureSha256)) return null;
  const handsetSha256 = handsetFingerprint(handsetLocation);
  return { actorId, photoCaptureSha256, receivedAt: delivery.proof.receivedAt,
    handsetSha256: replay && previousReceipt.handsetSha256 !== handsetSha256 ? null : handsetSha256 };
}

export function fleetProofForReporting(receipt, proof) {
  const photoCaptureSha256 = photoFingerprint(proof);
  if (!receipt || !photoCaptureSha256 || !objectId.test(receipt.actorId ?? '') || receipt.photoCaptureSha256 !== photoCaptureSha256
      || !receipt.receivedAt || !proof.receivedAt || +new Date(receipt.receivedAt) !== +new Date(proof.receivedAt)) return null;
  return { cameraReceiptBound: true, completionDriverId: receipt.actorId,
    handsetLocationBound: Boolean(receipt.handsetSha256 && receipt.handsetSha256 === handsetFingerprint(proof.location)) };
}
