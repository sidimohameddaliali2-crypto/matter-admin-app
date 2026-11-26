import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, IconButton, useMediaQuery } from '@mui/material';
import { ArrowLeft, Camera, ChevronRight, LogOut, MapPin, RefreshCw } from 'lucide-react';
import { useDispatch } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';
import { logout } from '../store/slices/authSlice';
import { DRIVER_LOGIN_PATH } from '../utils/yellowblockDriverPaths';
import OrderCameraCapture from '../components/deliveries/OrderCameraCapture';
import ShopifyShippingMap from '../components/deliveries/ShopifyShippingMap';

const orderPath = '/yellowblock/driver/orders';
const queues = [
  { status: 'prepared', label: 'To collect', empty: 'No orders ready to collect.' },
  { status: 'collected', label: 'To deliver', empty: 'No orders to deliver.' },
  { status: 'delivered', label: 'Delivered', empty: 'No completed deliveries yet.' },
];
const deliveryTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai' });
const buttonClass = 'flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#a23119] px-4 text-base font-semibold text-white hover:bg-[#822813] disabled:opacity-50';
const photoClass = 'max-h-64 w-full rounded-xl bg-gray-100 object-contain';
const requestError = (error, fallback) => error.response?.data?.message || fallback;

function Photo({ blob, alt, className }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) return undefined;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url ? <img src={url} alt={alt} className={className} /> : null;
}

function StoredPhoto({ id, delivery = false }) {
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState(false);
  const title = delivery ? 'Delivery photo' : 'Packed-box photo from Kitchen';
  useEffect(() => {
    const controller = new AbortController();
    api.get(`${orderPath}/${id}/${delivery ? 'delivery-photo' : 'packed-photo'}`, { signal: controller.signal, responseType: 'blob' })
      .then(({ data }) => { if (!controller.signal.aborted) setPhoto(data); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [id, delivery]);

  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {photo ? <Photo blob={photo} alt={delivery ? 'Saved delivery photo' : 'Order inside its box, photographed by Kitchen'} className={photoClass} /> : (
        <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600" role="status">
          {error ? `Could not load the ${delivery ? 'delivery' : 'packed-box'} photo.` : `Loading ${delivery ? 'delivery' : 'packed-box'} photo…`}
        </p>
      )}
    </section>
  );
}

function DriverOrder({ id, onUpdate, onBusy }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.get(`${orderPath}/${id}`, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setOrder(data.data); })
      .catch(reason => { if (!controller.signal.aborted) setError(requestError(reason, 'Could not load this order.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, retry]);

  const update = async action => {
    setSaving(true);
    onBusy(true);
    setError('');
    let data;
    try {
      let body;
      if (action === 'deliver') {
        body = new FormData();
        body.append('deliveryPhoto', photo, 'delivery.jpg');
      }
      ({ data } = await api.post(`${orderPath}/${id}/${action}`, body));
    } catch (reason) {
      setError(requestError(reason, 'Could not save. Check your connection and try again.'));
    } finally {
      setSaving(false);
      onBusy(false);
    }
    if (data) onUpdate(id, data.data);
  };

  if (loading) return <p role="status" className="text-sm text-gray-600">Loading order…</p>;
  if (!order) return (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-red-800">{error}</p>
      <button type="button" onClick={() => setRetry(value => value + 1)} className={buttonClass}>Retry</button>
    </div>
  );

  if (order.status === 'delivered') return (
    <div className="space-y-4 pb-4">
      <section className="space-y-2 rounded-xl border border-gray-200 bg-white p-3" aria-label="Completed delivery">
        <h3 className="break-words text-base font-bold">{order.customerName}</h3>
        {order.emirate && <p className="text-sm text-gray-600">{order.emirate}</p>}
        {order.deliveredAt && <time className="text-sm text-gray-700" dateTime={order.deliveredAt}>{deliveryTime.format(new Date(order.deliveredAt))} · Dubai time</time>}
      </section>
      {order.hasDeliveryPhoto ? <StoredPhoto id={id} delivery /> : <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">No delivery photo was saved for this order.</p>}
    </div>
  );

  const address = order.shippingAddress;
  const addressText = address && [...new Set([address.address1, address.address2, address.city, address.province].filter(Boolean))].join(', ');
  return (
    <div className="space-y-4">
      <section className="space-y-2 rounded-xl border border-gray-200 bg-white p-3" aria-label="Delivery address">
        <h3 className="break-words text-base font-bold">{order.customerName}</h3>
        <div className="flex items-start gap-2 text-sm text-gray-700">
          <MapPin size={18} className="shrink-0 text-[#a23119]" aria-hidden="true" />
          <address className="break-words not-italic">{addressText || 'No delivery address provided.'}</address>
        </div>
        {address && <ShopifyShippingMap address={address} />}
      </section>
      {order.hasPackedPhoto && <StoredPhoto id={id} />}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      {order.status === 'prepared' && (
        <button type="button" className={buttonClass} disabled={saving} onClick={() => update('collect')}>
          {saving ? 'Saving…' : 'Mark collected'}
        </button>
      )}
      {order.status === 'collected' && (
        <section className="space-y-3 border-t border-gray-200 pt-4">
          <h3 className="font-semibold">Delivery photo</h3>
          {photo && <Photo blob={photo} alt="Delivery photo to be saved" className={photoClass} />}
          <button type="button" disabled={saving} onClick={() => setCameraOpen(true)}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-[#a23119] px-4 font-semibold text-[#a23119] disabled:opacity-50">
            <Camera size={20} aria-hidden="true" /> {photo ? 'Retake delivery photo' : 'Take delivery photo'}
          </button>
          <button type="button" className={buttonClass} disabled={!photo || saving} onClick={() => update('deliver')}>
            {saving ? 'Saving…' : 'Complete delivery'}
          </button>
        </section>
      )}
      {cameraOpen && <OrderCameraCapture label="Take delivery photo" onClose={() => setCameraOpen(false)} onCapture={captured => {
        setPhoto(captured);
        setCameraOpen(false);
      }} />}
    </div>
  );
}

export default function YellowblockDriver() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const mobile = useMediaQuery('(max-width: 639px)');
  const standalone = useMediaQuery('(display-mode: standalone)') || Boolean(navigator.standalone);
  const [tab, setTab] = useState('prepared');
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.get(orderPath, { params: { includeDelivered: true }, signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setOrders(data.data); })
      .catch(reason => { if (!controller.signal.aborted) setError(requestError(reason, 'Could not load assigned orders.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  const updateOrder = (id, update) => {
    setOrders(current => current.map(order => order.id === id ? { ...order, ...update } : order));
    setSelected(null);
    setTab(update.status);
    setNotice(update.status === 'delivered' ? 'Delivery completed.' : 'Order moved to To deliver.');
  };
  const visible = orders.filter(order => order.status === tab);
  if (tab === 'delivered') visible.sort((a, b) => (b.deliveredAt || '').localeCompare(a.deliveredAt || ''));
  const activeQueue = queues.find(queue => queue.status === tab);
  const close = () => { if (!busy) setSelected(null); };

  return (
    <main className="min-h-[100dvh] bg-[#faf9f7] text-gray-900" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header className="sticky top-0 z-10 border-b border-[#f0d7cc] bg-[#fbeae2]" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex min-h-16 max-w-3xl items-center justify-between gap-2 px-4">
          <div className="flex items-center gap-3">
            {!standalone && <Link to="/driver-mobile" aria-label="Back to Matter driver app" className="grid h-11 w-11 place-items-center rounded-full bg-white/70"><ArrowLeft size={20} aria-hidden="true" /></Link>}
            <h1 className="text-lg font-bold">Yellow Block Driver</h1>
          </div>
          <button type="button" aria-label="Sign out" className="grid h-11 w-11 place-items-center rounded-full hover:bg-white/70" onClick={() => {
            dispatch(logout());
            navigate(DRIVER_LOGIN_PATH, { replace: true });
          }}><LogOut size={20} aria-hidden="true" /></button>
        </div>
      </header>

      <section className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Delivery queue" className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-xl bg-[#fbeae2] p-1">
            {queues.map(({ status, label }) => (
              <button key={status} type="button" aria-pressed={tab === status} onClick={() => {
                recordActivityChange({ field: 'Queue', form: 'Yellow Block Driver', before: activeQueue.label, after: label });
                setTab(status);
                setNotice('');
              }}
                className={`min-h-11 rounded-lg px-1 text-xs font-semibold sm:px-2 sm:text-sm ${tab === status ? 'bg-white text-gray-900 shadow-sm' : 'text-[#822813]'}`}>
                {label} ({orders.filter(order => order.status === status).length})
              </button>
            ))}
          </div>
          <button type="button" aria-label="Refresh orders" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-gray-200 bg-white" disabled={loading}
            onClick={() => setRefresh(value => value + 1)}><RefreshCw size={18} className={loading ? 'animate-spin' : ''} aria-hidden="true" /></button>
        </div>
        {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{notice}</p>}
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        {loading ? <p role="status" className="p-3 text-sm text-gray-600">Loading assigned orders…</p> : visible.length ? (
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
            {visible.map(order => (
              <li key={order.id}>
                <button type="button" onClick={() => setSelected(order)} className="flex min-h-[4.5rem] w-full items-center justify-between gap-3 p-3 text-left hover:bg-orange-50">
                  <span className="min-w-0">
                    <span className="block break-words font-semibold">{order.customerName}</span>
                    <span className="block text-sm text-gray-600">{order.name}{order.emirate && ` · ${order.emirate}`}</span>
                    {order.deliveredAt && <time className="block text-xs text-gray-600" dateTime={order.deliveredAt}>{deliveryTime.format(new Date(order.deliveredAt))}</time>}
                  </span>
                  <ChevronRight size={18} className="shrink-0 text-gray-500" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : !error && <p className="rounded-xl bg-white p-4 text-sm text-gray-600">{activeQueue.empty}</p>}
      </section>

      <Dialog open={Boolean(selected)} onClose={close} fullScreen={mobile} fullWidth maxWidth="sm" aria-labelledby="driver-order-title"
        PaperProps={{ sx: { paddingTop: mobile ? 'env(safe-area-inset-top)' : 0, paddingBottom: mobile ? 'env(safe-area-inset-bottom)' : 0 } }}>
        {selected && <>
          <DialogTitle id="driver-order-title" sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, fontWeight: 700 }}>
            <IconButton aria-label="Back to orders" onClick={close} disabled={busy} sx={{ width: 44, height: 44 }}><ArrowLeft size={21} /></IconButton>
            Order {selected.name}
          </DialogTitle>
          <DialogContent dividers><DriverOrder key={selected.id} id={selected.id} onUpdate={updateOrder} onBusy={setBusy} /></DialogContent>
        </>}
      </Dialog>
    </main>
  );
}
