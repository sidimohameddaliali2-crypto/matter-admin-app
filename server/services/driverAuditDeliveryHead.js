import { isDriverAuditLightReference } from './driverAuditLightArchive.js';

export function isDriverAuditDeliveryHead(value) {
  const fields = ['version', 'ref', 'collectorRevision', 'sourceBodySha256', 'visibleCutoffAt'];
  return Boolean(value && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
    && value.version === 1 && isDriverAuditLightReference(value.ref)
    && Number.isSafeInteger(value.collectorRevision) && value.collectorRevision > 0
    && typeof value.sourceBodySha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sourceBodySha256)
    && typeof value.visibleCutoffAt === 'string' && Number.isFinite(Date.parse(value.visibleCutoffAt))
    && new Date(value.visibleCutoffAt).toISOString() === value.visibleCutoffAt);
}

export function driverAuditDeliveryIdentity(head) {
  return {
    generation: head?.deliveryView?.ref.sha256 ?? head?.generation ?? null,
    collectorRevision: head?.deliveryView?.collectorRevision ?? head?.servingPackage?.collectorRevision ?? null,
    visibleCutoffAt: head?.deliveryView?.visibleCutoffAt ?? head?.visibleCutoffAt ?? null,
  };
}

export function driverAuditRetainedLightHeads(head) {
  const results = [head];
  if (head.deliveryView) {
    const { deliveryView, previousDeliveryView, ...base } = head;
    if (previousDeliveryView) results.push({ ...base, deliveryView: previousDeliveryView });
    results.push(base);
  }
  if (head.previous?.lightView) results.push(head.previous);
  return results;
}
