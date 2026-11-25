import { createHash } from 'node:crypto';
import { CaptureRequestError } from './driverCaptureEvents.js';

export const MAX_CAPTURE_PHOTO_BYTES = 750000;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

export async function ingestDriverCapturePhoto({ actor, photoId, eventId, contentMd5, bytes, repository, now = () => new Date() }) {
  if (!actor?.id || actor.role !== 'driver') throw new CaptureRequestError(403, 'Driver account required');
  if (!validId(photoId) || !validId(eventId)) throw new CaptureRequestError(400, 'Invalid evidence identity');
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_CAPTURE_PHOTO_BYTES) throw new CaptureRequestError(413, 'Expected a JPEG no larger than 750000 bytes');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new CaptureRequestError(422, 'JPEG framing is invalid');
  const md5 = createHash('md5').update(bytes).digest('hex');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (typeof contentMd5 !== 'string' || md5 !== contentMd5.toLowerCase()) throw new CaptureRequestError(409, 'Photo checksum mismatch');
  const ledger = await repository.findEvent({ accountId: actor.id, eventId });
  const event = ledger?.originalEvent;
  if (!event || event.accountId !== actor.id || event.eventType !== 'photo.captured' || event.data?.photoId !== photoId) throw new CaptureRequestError(409, 'Photo capture ledger entry required');
  const data = event.data;
  if (data.byteSize !== bytes.length || data.contentMd5?.toLowerCase() !== md5) throw new CaptureRequestError(409, 'Bytes differ from original capture evidence');
  // An already committed retry remains valid after reassignment; it cannot replace bytes.
  const previous = await repository.findPhoto({ accountId: actor.id, photoId });
  if (!previous && !await repository.ownsDelivery({ accountId: actor.id, deliveryId: data.deliveryId })) throw new CaptureRequestError(403, 'Delivery is not assigned to this driver');
  const record = { accountId: actor.id, photoId, eventId, deliveryId: data.deliveryId,
    ledgerPayloadHash: ledger.payloadHash, contentMd5: md5, contentSha256: sha256,
    byteSize: bytes.length, originalBytes: bytes, serverRecordedAt: now(), associationVerified: true };
  const receipt = await repository.acceptPhoto(record);
  if (receipt.contentSha256 !== sha256 || receipt.eventId !== eventId || receipt.ledgerPayloadHash !== ledger.payloadHash) throw new CaptureRequestError(409, 'Photo identity conflict');
  return { success: true, data: { photoId, eventId, contentMd5: md5, contentSha256: sha256,
    byteSize: bytes.length, duplicate: receipt.duplicate === true, durablyStored: true,
    associationVerified: true, ledgerOnly: true, deliveryStateApplied: false } };
}
