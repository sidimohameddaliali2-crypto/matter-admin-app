import React, { useEffect, useState } from 'react';
import { Camera, CheckCircle2, Circle } from 'lucide-react';
import api from '../../utils/api';
import OrderCameraCapture from './OrderCameraCapture';

const statusLabels = {
  pending: 'Awaiting acknowledgment',
  in_preparation: 'Order in preparation',
  prepared: 'Order prepared',
  collected: 'Driver collected',
  delivered: 'Order delivered',
};

const milestones = ['in_preparation', 'prepared', 'collected', 'delivered'];
const photoSlots = [
  ['displayPhoto', 'Order displayed outside the box'],
  ['boxedPhoto', 'Order inside the box'],
];
const allPhotoSlots = [...photoSlots, ['deliveryPhoto', 'Delivery photo']];
const timestamp = new Intl.DateTimeFormat('en-AE', {
  timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short',
});
const orderPath = id => `/yellowblock/kitchen/orders/${id}`;
const inputClass = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm';
const primaryClass = 'rounded-lg bg-[#a23119] px-3 py-2 text-sm font-semibold text-white hover:bg-[#822813] disabled:opacity-50';
const kitchenPrimaryClass = `${primaryClass} min-h-14 w-full rounded-xl text-base`;

function PhotoThumbnail({ photo }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const objectUrl = URL.createObjectURL(photo);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo]);
  return url ? <img src={url} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" /> : null;
}

function OrderPhotos({ id, hasDeliveryPhoto }) {
  const [photos, setPhotos] = useState(null);
  const [error, setError] = useState('');
  const slots = hasDeliveryPhoto ? allPhotoSlots : photoSlots;

  useEffect(() => {
    const controller = new AbortController();
    let urls = [];
    Promise.all(slots.map(([slot]) => api.get(`${orderPath(id)}/photos/${slot}`, {
      responseType: 'blob', signal: controller.signal,
    }))).then(results => {
      if (controller.signal.aborted) return;
      urls = results.map(({ data }) => URL.createObjectURL(data));
      setPhotos(urls);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Could not load the preparation photos.');
    });
    return () => {
      controller.abort();
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [id, slots]);

  if (error) return <p role="alert" className="text-sm text-red-800">{error}</p>;
  if (!photos) return <p role="status" className="text-sm text-gray-600">Loading photos…</p>;
  return (
    <div className="grid grid-cols-2 gap-3">
      {slots.map(([slot, label], index) => (
        <figure key={slot}>
          <img src={photos[index]} alt={label} className="aspect-square w-full rounded-lg bg-gray-100 object-contain" />
          <figcaption className="mt-1 text-xs text-gray-600">{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function KitchenDetails({ order }) {
  return (
    <section className="space-y-3">
      <dl className="yb-panel flex flex-wrap gap-x-6 gap-y-3 p-4 text-sm">
        <div><dt className="text-gray-600">Customer</dt><dd className="font-semibold">{order.customerName}</dd></div>
        <div><dt className="text-gray-600">Emirate</dt><dd className="font-semibold">{order.emirate || '—'}</dd></div>
        {order.courier && <div><dt className="text-gray-600">Courier</dt><dd className="font-semibold">{order.courier}</dd></div>}
      </dl>
      <h3 className="yb-team-title">Order items</h3>
      <ul className="yb-panel divide-y text-sm">
        {order.items.map((item, index) => (
          <li key={`${item.title}-${index}`} className="flex justify-between gap-4 p-3">
            <span>{item.title}{item.variant && <span className="block text-gray-600">{item.variant}</span>}</span>
            <span className="whitespace-nowrap font-semibold">× {item.quantity}</span>
          </li>
        ))}
        {order.items.length === 0 && <li className="p-3 text-gray-600">No items</li>}
      </ul>
    </section>
  );
}

export default function YellowblockOrderWorkflow({ id, kitchen = false, allowAssignment = true, onChange }) {
  const [order, setOrder] = useState(null);
  const [courier, setCourier] = useState('');
  const [photos, setPhotos] = useState({});
  const [cameraSlot, setCameraSlot] = useState(null);
  const [showPhotos, setShowPhotos] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.get(orderPath(id), { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return;
      setOrder(data.data);
      setCourier(data.data.courierId);
    }).catch(requestError => {
      if (!controller.signal.aborted) setError(requestError.response?.data?.message || 'Could not load the order.');
    });
    return () => controller.abort();
  }, [id, reload]);

  const submit = async (type, status) => {
    setSaving(true);
    setError('');
    try {
      let response;
      if (type === 'courier') {
        response = await api.patch(`${orderPath(id)}/courier`, { courierId: courier });
      } else {
        const body = status === 'prepared' ? new FormData() : undefined;
        if (body) photoSlots.forEach(([slot]) => body.append(slot, photos[slot], `${slot}.jpg`));
        response = await api.post(`${orderPath(id)}/status/${status}`, body);
      }
      const update = response.data.data;
      setOrder(current => ({ ...current, ...update }));
      if (status === 'prepared') setPhotos({});
      onChange?.(id, update);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not save the order update.');
      if (requestError.response?.status === 409) setReload(current => current + 1);
    } finally {
      setSaving(false);
    }
  };

  if (!order) {
    return error ? (
      <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
        {error} <button type="button" className="font-semibold underline" onClick={() => { setError(''); setReload(value => value + 1); }}>Retry</button>
      </div>
    ) : <p role="status" className="text-sm text-gray-600">Loading order workflow…</p>;
  }

  const errorMessage = error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>;

  if (kitchen) {
    const canAcknowledge = !order.cancelled && !order.shopifyFulfilled && order.status === 'pending';
    const canPrepare = !order.cancelled && order.status === 'in_preparation';

    return (
      <div className="space-y-4 text-gray-900">
        <KitchenDetails order={order} />
        {errorMessage}
        {canAcknowledge && (
          <button type="button" className={kitchenPrimaryClass} disabled={saving} onClick={() => submit('status', 'in_preparation')}>
            {saving ? 'Saving…' : 'Acknowledge'}
          </button>
        )}
        {canPrepare && (
          <form className="space-y-3 border-t border-gray-200 pt-4" onSubmit={event => { event.preventDefault(); submit('status', 'prepared'); }}>
            <h3 className="text-sm font-semibold">Take two photos</h3>
            {photoSlots.map(([slot, label], index) => {
              const photo = photos[slot];
              const action = photo ? 'Retake photo' : 'Open camera';
              return (
                <button key={slot} type="button" aria-label={`${action}: ${label}`} onClick={() => setCameraSlot([slot, label])}
                  disabled={saving || (index === 1 && !photos.displayPhoto)}
                  className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 text-left hover:bg-orange-50 disabled:opacity-45">
                  {photo ? <PhotoThumbnail photo={photo} /> : (
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-[#fbeae2] text-[#a23119]"><Camera size={22} aria-hidden="true" /></span>
                  )}
                  <span className="min-w-0">
                    <span className="block font-semibold">{index + 1}. {label}</span>
                    <span className="block text-sm text-[#a23119]">{action}</span>
                  </span>
                </button>
              );
            })}
            <button type="submit" className={kitchenPrimaryClass} disabled={saving || photoSlots.some(([slot]) => !photos[slot])}>
              {saving ? 'Saving…' : 'Done'}
            </button>
          </form>
        )}
        {cameraSlot && (
          <OrderCameraCapture label={cameraSlot[1]} onClose={() => setCameraSlot(null)} onCapture={photo => {
            const [slot] = cameraSlot;
            setPhotos(current => ({ ...current, [slot]: photo }));
            setCameraSlot(null);
          }} />
        )}
        {order.cancelled ? <p className="text-sm text-gray-600">Cancelled or test order</p> : order.hasPhotos && (
          <p role="status" className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Order prepared
          </p>
        )}
      </div>
    );
  }

  const canAssign = allowAssignment && order.canDispatch && !order.cancelled && ['pending', 'in_preparation', 'prepared'].includes(order.status)
    && !(order.shopifyFulfilled && order.status === 'pending');

  return (
    <div className="space-y-4 text-gray-900">
      <div className="rounded-lg border border-gray-200 p-3">
        <p className="text-sm font-semibold">Delivery courier</p>
        <p className="mt-1 text-sm text-gray-600">{order.courier || 'Unassigned'}</p>
        {canAssign && (
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); submit('courier'); }}>
            <select aria-label="Assign delivery courier" value={courier} onChange={event => setCourier(event.target.value)}
              className={`${inputClass} sm:w-auto`} disabled={saving}>
              <option value="">Choose a courier</option>
              <optgroup label="App drivers">
                {order.couriers.filter(option => option.driver).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              </optgroup>
              <optgroup label="Third-party couriers">
                {order.couriers.filter(option => !option.driver).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              </optgroup>
            </select>
            <button type="submit" className={primaryClass} disabled={saving || !courier || courier === order.courierId}>Assign courier</button>
          </form>
        )}
      </div>

      <section className="rounded-lg border border-gray-200 p-3">
        <h3 className="mb-3 text-sm font-semibold">Order timeline</h3>
        <ol className="space-y-3">
          {milestones.map(status => {
            const event = order.timeline.find(entry => entry.status === status);
            return (
              <li key={status} className="flex gap-2 text-sm">
                {event ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" aria-label="Completed" /> : <Circle className="h-4 w-4 shrink-0 text-gray-400" aria-label="Pending" />}
                <div>
                  <p className={event ? 'font-semibold' : 'text-gray-600'}>{statusLabels[status]}{event?.courier && ` · ${event.courier}`}</p>
                  {event && <p className="text-xs text-gray-600">{timestamp.format(new Date(event.at))} · Recorded by {event.actor}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {order.cancelled && <p className="text-sm text-gray-600">Cancelled or test order</p>}
      {errorMessage}
      {order.canDispatch && !order.cancelled && !order.driverAssigned && order.status === 'prepared' && (
        <button type="button" className={primaryClass} disabled={saving || !order.courier} onClick={() => submit('status', 'collected')}>Mark driver collected</button>
      )}
      {order.canDispatch && !order.cancelled && !order.driverAssigned && order.status === 'collected' && (
        <button type="button" className={primaryClass} disabled={saving} onClick={() => submit('status', 'delivered')}>Mark delivered</button>
      )}
      {order.hasPhotos && (
        <div className="space-y-2">
          <button type="button" aria-expanded={showPhotos} className="text-sm font-semibold text-[#a23119] underline" onClick={() => setShowPhotos(current => !current)}>
            {showPhotos ? 'Hide order photos' : order.hasDeliveryPhoto ? 'View order photos' : 'View preparation photos'}
          </button>
          {showPhotos && <OrderPhotos key={`${id}:${order.hasDeliveryPhoto}`} id={id} hasDeliveryPhoto={order.hasDeliveryPhoto} />}
        </div>
      )}
    </div>
  );
}
