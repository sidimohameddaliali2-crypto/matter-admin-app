// Pure receipt reconstruction from authoritative per-bag movement events.
// Preparation never counts as acceptance, even when a later physical scan moves a bag.
export function buildDispatcherHandovers(rows, users = []) {
  const names = new Map(users.map(u => [String(u._id), [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ') || u.name || 'Driver']));
  const receipts = new Map(),
    movements = new Map();
  for (const {
    bagId,
    event
  } of rows) {
    if (event.eventType === 'pack' && /^handover:[a-f0-9-]{36}:/.test(event.eventId || '')) {
      const receiptId = event.eventId.split(':').slice(0, 4).join(':');
      if (!receipts.has(receiptId)) receipts.set(receiptId, {
        id: receiptId,
        preparedAt: event.timestamp,
        dispatcherId: String(event.assignedBy?.user || ''),
        dispatcherName: event.assignedBy?.name || 'Staff',
        driverId: String(event.assignedTo?.driver || ''),
        note: event.notes || '',
        bags: []
      });
      const receipt = receipts.get(receiptId);
      if (!receipt.bags.some(b => b.eventId === event.eventId)) receipt.bags.push({
        bagId,
        eventId: event.eventId,
        status: 'pending',
        acceptedAt: null
      });
    }
    const preparedEvent = event.before?.pendingHandover?.eventId;
    if (preparedEvent) {
      const prior = movements.get(preparedEvent);
      // Only the first movement after preparation settles that offer.
      if (!prior || new Date(event.timestamp) < new Date(prior.timestamp)) movements.set(preparedEvent, event);
    }
  }
  return [...receipts.values()].map(receipt => {
    for (const bag of receipt.bags) {
      const event = movements.get(bag.eventId);
      if (event?.eventType === 'accept' && String(event.assignedBy?.user) === receipt.driverId) {
        bag.status = 'accepted';
        bag.acceptedAt = event.timestamp;
      } else if (event?.eventType === 'cancel_handover') bag.status = 'cancelled';else if (event) bag.status = 'exception';
    }
    const acceptedCount = receipt.bags.filter(b => b.status === 'accepted').length;
    const pendingCount = receipt.bags.filter(b => b.status === 'pending').length;
    const status = acceptedCount === receipt.bags.length ? 'accepted' : pendingCount === receipt.bags.length ? 'pending' : receipt.bags.every(b => b.status === 'cancelled') ? 'cancelled' : 'partial';
    return {
      ...receipt,
      driverName: names.get(receipt.driverId) || 'Driver',
      preparedCount: receipt.bags.length,
      acceptedCount,
      pendingCount,
      status
    };
  }).sort((a, b) => new Date(b.preparedAt) - new Date(a.preparedAt));
}
export function validateDispatcherHandover(input) {
  const {
    requestId,
    driverId,
    bags,
    note,
    confirmed
  } = input || {};
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId) || typeof driverId !== 'string' || !/^[a-f0-9]{24}$/i.test(driverId) || confirmed !== true || !Array.isArray(bags) || !bags.length || bags.length > 500 || typeof note !== 'string' || note.length > 2000 || bags.some(b => !b || typeof b !== 'object' || typeof b.bagId !== 'string' || !b.bagId.trim() || b.bagId.length > 160 || !Number.isInteger(b.expectedVersion) || b.expectedVersion < 0)) return 'Confirm a receiving driver, 1–500 scanned bags, their versions, and a stable request ID.';
  return null;
}
