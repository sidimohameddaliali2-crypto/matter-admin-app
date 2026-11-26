import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, IconButton, useMediaQuery } from '@mui/material';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, LogOut, Package, RefreshCw, UtensilsCrossed } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';
import YellowblockOrderWorkflow from '../components/deliveries/YellowblockOrderWorkflow';
import { logout } from '../store/slices/authSlice';
import { KITCHEN_LOGIN_PATH } from '../utils/yellowblockKitchenPaths';
import './YellowblockApp.css';

const controlsClass = 'yb-button yb-button-secondary';
const preparationStatus = (order) => {
  if (order.cancelled) return 'Cancelled or test';
  if (order.hasPhotos) return 'Prepared';
  if (order.status === 'in_preparation') return 'Preparing';
  return order.shopifyFulfilled ? 'Fulfilled' : 'New';
};

export default function YellowblockKitchen() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const role = useSelector(state => state.auth.user?.role);
  const phoneLayout = useMediaQuery('(max-width: 639px)');
  const standalone = useMediaQuery('(display-mode: standalone)') || Boolean(navigator.standalone);
  const [cursor, setCursor] = useState(null);
  const [page, setPage] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [filter, setFilter] = useState('all');
  const orders = page?.orders || [];
  const activeOrders = orders.filter(order => ['New', 'Preparing'].includes(preparationStatus(order)));
  const finishedOrders = orders.filter(order => preparationStatus(order) === 'Prepared');
  const queues = [
    { key: 'all', label: 'All orders', orders },
    { key: 'active', label: 'To prepare', orders: activeOrders },
    { key: 'finished', label: 'Prepared', orders: finishedOrders },
  ];
  const visible = queues.find(queue => queue.key === filter).orders;

  useEffect(() => {
    if (standalone) return undefined;
    const offerInstall = event => { event.preventDefault(); setInstallPrompt(event); };
    window.addEventListener('beforeinstallprompt', offerInstall);
    return () => window.removeEventListener('beforeinstallprompt', offerInstall);
  }, [standalone]);

  const install = async () => {
    if (!installPrompt) {
      setShowInstallHelp(value => !value);
      return;
    }
    setInstallPrompt(null);
    try {
      await installPrompt.prompt();
    } catch {
      setShowInstallHelp(true);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.get('/yellowblock/kitchen/orders', { params: { cursor }, signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setPage(data.data);
    }).catch(requestError => {
      if (!controller.signal.aborted) setError(requestError.response?.data?.message || 'Could not load Shopify orders.');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [cursor, refresh]);

  const updateOrder = (id, update) => {
    setPage(current => current && ({ ...current, orders: current.orders.map(order => order.id === id ? { ...order, ...update } : order) }));
  };

  return (
    <main className="yb-team-page min-h-[100dvh]" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header className="yb-team-header sticky top-0 z-10 border-b" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex min-h-16 max-w-3xl items-center justify-between gap-2 px-4">
          <div className="flex min-w-0 items-center gap-3">
            {!standalone && role && role !== 'kitchen' && (
              <Link to="/yellowblock" aria-label="Back to Yellow Block" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/70">
                <ArrowLeft size={20} aria-hidden="true" />
              </Link>
            )}
            <img src="/images/yellow-block-logo.png.png" alt="Yellow Block" className="h-8 w-auto" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!standalone && (phoneLayout || installPrompt) && (
              <button type="button" onClick={install} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-[#8d2c18]">
                <Download size={17} aria-hidden="true" /> Install
              </button>
            )}
            <button type="button" aria-label="Sign out" className="grid h-11 w-11 place-items-center rounded-full hover:bg-white/70" onClick={() => {
              dispatch(logout());
              navigate(KITCHEN_LOGIN_PATH, { replace: true });
            }}>
              <LogOut size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>
      <section className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        {showInstallHelp && <p className="mb-4 rounded-xl bg-white p-3 text-sm text-gray-700">On iPhone, open Safari’s Share menu and choose Add to Home Screen. On Android, open Chrome’s menu and choose Install app or Add to Home screen.</p>}
        <header className="yb-team-hero">
          <span className="yb-summary-icon yb-summary-icon-lilac"><UtensilsCrossed size={21} aria-hidden="true" /></span>
          <h1>Kitchen</h1>
          <p>Open an order to start preparing it or take packing photos.</p>
        </header>
        <div className="flex items-center justify-between gap-3">
          <h2 className="yb-team-title">Order queue</h2>
          <button type="button" className={controlsClass} disabled={loading} onClick={() => setRefresh(value => value + 1)}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
          </button>
        </div>

        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        {loading ? <p role="status" className="yb-panel p-4 text-sm text-gray-600">Loading orders…</p> : page && (
          <>
            <div className="yb-kitchen-filters" role="group" aria-label="Filter orders on this page">
              {queues.map(queue => (
                <button key={queue.key} type="button" aria-pressed={filter === queue.key} onClick={() => {
                  recordActivityChange({ field: 'Queue filter', form: 'Yellow Block Kitchen', before: queues.find(item => item.key === filter).label, after: queue.label });
                  setFilter(queue.key);
                }}>
                  {queue.label} <span>{queue.orders.length}</span>
                </button>
              ))}
            </div>
            {visible.length === 0 ? <p className="yb-panel p-4 text-sm text-gray-600">No matching orders on this page.</p> : (
              <ul className="space-y-2">
                {visible.map(order => (
                  <li key={order.id}>
                    <button type="button" onClick={() => setSelected(order)}
                      className="yb-panel yb-team-order">
                      <span className="yb-summary-icon yb-summary-icon-peach yb-kitchen-order-icon"><Package size={19} aria-hidden="true" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold text-gray-600">{order.name}</span>
                        <span className="block break-words text-sm font-bold">{order.customerName}</span>
                        <span className="mt-0.5 block text-xs text-gray-600">{order.items.reduce((count, item) => count + item.quantity, 0)} items{order.emirate && ` · ${order.emirate}`}{order.courier && ` · ${order.courier}`}</span>
                      </span>
                      <span className="yb-kitchen-status" data-status={preparationStatus(order)}>
                        {preparationStatus(order)}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(page.previousCursor || page.nextCursor) && (
              <nav aria-label="Shopify order pages" className="flex justify-between">
                <button type="button" className={controlsClass} disabled={!page.previousCursor} onClick={() => setCursor(page.previousCursor)}>
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
                </button>
                <button type="button" className={controlsClass} disabled={!page.nextCursor} onClick={() => setCursor(page.nextCursor)}>
                  Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </nav>
            )}
          </>
        )}
      </section>

      <Dialog open={Boolean(selected)} onClose={() => setSelected(null)} fullScreen={phoneLayout} fullWidth maxWidth="sm" aria-labelledby="kitchen-order-title"
        PaperProps={{ className: 'yb-team-page', sx: { bgcolor: '#fcf5ee', paddingTop: phoneLayout ? 'env(safe-area-inset-top)' : 0, paddingBottom: phoneLayout ? 'env(safe-area-inset-bottom)' : 0 } }}>
        {selected && <>
          <DialogTitle id="kitchen-order-title" sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, bgcolor: '#fceadd', fontFamily: 'Georgia, serif', fontSize: '1.5rem' }}>
            <IconButton aria-label="Back to orders" onClick={() => setSelected(null)} sx={{ width: 44, height: 44 }}>
              <ArrowLeft size={21} />
            </IconButton>
            Order {selected.name}
          </DialogTitle>
          <DialogContent dividers>
            <YellowblockOrderWorkflow key={selected.id} id={selected.id} kitchen onChange={updateOrder} />
          </DialogContent>
        </>}
      </Dialog>
    </main>
  );
}
