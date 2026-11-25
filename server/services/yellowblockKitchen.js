import sharp from 'sharp';

export const kitchenTransitions = {
  in_preparation: { previous: 'pending', kitchen: true },
  prepared: { previous: 'in_preparation', kitchen: true },
  collected: { previous: 'prepared' },
  delivered: { previous: 'collected' },
};

export const courierPresets = ['Ali', 'Snack Out', 'Lalamove'];

export const driverCourierId = id => `driver:${id}`;
export const displayName = user => [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ');

export async function compressOrderPhoto(buffer) {
  // Re-encode the image and strip metadata, including camera GPS.
  return sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 }).toBuffer();
}

const emirates = {
  AZ: 'Abu Dhabi', AJ: 'Ajman', DU: 'Dubai', FU: 'Fujairah',
  RK: 'Ras Al Khaimah', SH: 'Sharjah', UQ: 'Umm Al Quwain',
};

export function kitchenOrder(order) {
  const shipping = order.shipping_address;
  const customer = order.customer;
  const provinceCode = shipping?.province_code?.toUpperCase().replace(/^AE-/, '');
  const cityEmirate = Object.values(emirates).find(name => name.toLowerCase() === shipping?.city?.trim().toLowerCase());
  return {
    id: String(order.id),
    name: order.name,
    customerName: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || shipping?.name || 'Guest',
    emirate: emirates[provinceCode] || shipping?.province || cityEmirate || '',
    cancelled: Boolean(order.cancelled_at || order.test),
    shopifyFulfilled: order.fulfillment_status === 'fulfilled',
    items: (order.line_items || []).filter(item => (item.current_quantity ?? item.quantity) > 0).map(item => ({
      title: item.title || item.name,
      variant: item.variant_title,
      quantity: item.current_quantity ?? item.quantity,
    })),
  };
}

export function kitchenWorkflow(workflow, assignment, { includeTimeline = false } = {}) {
  return {
    status: workflow?.status || 'pending',
    timeline: includeTimeline ? Object.keys(kitchenTransitions).flatMap(status => {
      const milestone = workflow?.[status];
      return milestone ? [{ status, at: milestone.at, actor: milestone.actor, courier: milestone.courier }] : [];
    }) : [],
    courier: workflow?.driverName || assignment?.company?.name || assignment?.courierName || '',
    courierId: workflow?.driverId ? driverCourierId(workflow.driverId) : assignment?.company?._id?.toString() || assignment?.courierName || '',
    driverAssigned: Boolean(workflow?.driverId),
    hasDeliveryPhoto: Boolean(workflow?.delivered?.photoTaken),
    hasPhotos: Boolean(workflow?.prepared),
  };
}
