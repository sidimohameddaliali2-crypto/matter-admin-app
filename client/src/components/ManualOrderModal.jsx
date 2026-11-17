import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronUp, ChevronDown, Loader2, ListOrdered } from 'lucide-react';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';

// Owner (2026-10-09): "create an option to choose the number of delivery —
// which one should be first, each one should be last — and this should feed
// the route tab." Lets a dispatcher manually sequence one driver's deliveries
// for a day directly from Dispatcher Hub, writing the same `routeOrder` field
// Optimize Routes writes, via the same /optimize-routes/apply endpoint — so
// this order is exactly what Driver Routes, the driver app, and ETA logic
// already read.
//
// Always operates on the driver's FULL set of deliveries for the day (not
// just whatever rows happen to be checked in the table), because routeOrder
// is a 0..n-1 sequence per driver — reordering only a subset would leave
// stale/overlapping order numbers on the rest of that driver's stops.

function getDriverDisplayName(driver) {
  if (!driver) return 'Unassigned';
  const parts = [driver.profile?.firstName, driver.profile?.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : driver.email || 'Driver';
}

function stopSort(a, b) {
  const ao = a.routeOrder ?? null;
  const bo = b.routeOrder ?? null;
  if (ao != null && bo != null) return ao - bo;
  if (ao != null) return -1;
  if (bo != null) return 1;
  return new Date(a.scheduledTime || 0) - new Date(b.scheduledTime || 0);
}

export default function ManualOrderModal({ open, onClose, deliveries, drivers, defaultDriverId, onSaved }) {
  const [driverId, setDriverId] = useState('');
  const [order, setOrder] = useState([]); // delivery ids, in edited order
  const latestOrder = useRef(order);
  latestOrder.current = order;
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { text, error }

  const driverOptions = useMemo(() => {
    const idsWithDeliveries = new Set(
      deliveries.filter((d) => d.driver?._id).map((d) => d.driver._id)
    );
    return drivers.filter((d) => idsWithDeliveries.has(d._id));
  }, [deliveries, drivers]);

  // Only re-initialize on the open=false→true transition, not on every
  // `driverOptions` recompute — a successful save triggers the parent to
  // refresh its delivery list, which reaches here as a new `deliveries`
  // (and therefore `driverOptions`) reference while the modal is still
  // open, and would otherwise wipe the just-shown success message
  // immediately (same class of bug as LiveTracking/geocode's earlier
  // optimistic-state-vs-prop-refresh issue).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const initial = defaultDriverId && driverOptions.some((d) => d._id === defaultDriverId)
        ? defaultDriverId
        : (driverOptions[0]?._id || '');
      setDriverId(initial);
      setMsg(null);
    }
    wasOpenRef.current = open;
  }, [open, defaultDriverId, driverOptions]);

  const driverDeliveries = useMemo(() => {
    if (!driverId) return [];
    return deliveries.filter((d) => d.driver?._id === driverId).sort(stopSort);
  }, [deliveries, driverId]);

  useEffect(() => {
    setOrder(driverDeliveries.map((d) => d._id));
  }, [driverDeliveries]);

  if (!open) return null;

  const move = (deliveryId, direction) => {
      const current = latestOrder.current;
      const idx = current.indexOf(deliveryId);
      const next = idx + direction;
      if (idx === -1 || next < 0 || next >= current.length) return;
      const copy = [...current];
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      changeOrder(copy);
  };

  const setPosition = (deliveryId, oneBasedPosition) => {
      const current = latestOrder.current;
      const idx = current.indexOf(deliveryId);
      if (idx === -1) return;
      const clamped = Math.min(Math.max(1, Math.round(oneBasedPosition) || 1), current.length) - 1;
      if (clamped === idx) return;
      const copy = [...current];
      const [item] = copy.splice(idx, 1);
      copy.splice(clamped, 0, item);
      changeOrder(copy, false);
  };

  const byId = new Map(driverDeliveries.map((d) => [d._id, d]));
  const stopLabel = id => {
    const name = byId.get(id)?.customerName;
    return !name || driverDeliveries.filter(stop => stop.customerName === name).length > 1 ? `${name || 'Customer'} (${id})` : name;
  };
  const changeOrder = (next, observe = true) => {
    if (observe) recordActivityChange({ field: `Stop order for ${getDriverDisplayName(drivers.find(driver => driver._id === driverId))}`, form: 'Arrange delivery order', before: latestOrder.current.map(stopLabel), after: next.map(stopLabel) });
    latestOrder.current = next;
    setOrder(next);
  };

  const handleSave = async () => {
    if (!driverId || order.length === 0) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.post('/deliveries/optimize-routes/apply', {
        routes: [{
          driverId,
          stops: order.map((deliveryId, i) => ({ deliveryId, routeOrder: i }))
        }]
      });
      setMsg({ text: `Saved the order for ${order.length} ${order.length === 1 ? 'delivery' : 'deliveries'}.`, error: false });
      onSaved?.();
    } catch (err) {
      setMsg({ text: err?.response?.data?.message || 'Could not save the order — nothing was changed.', error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <ListOrdered className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900">Arrange Delivery Order</h2>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100" aria-label="Close">
            <X className="w-5 h-5 text-gray-600" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-gray-200 space-y-1.5">
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Driver</label>
          {driverOptions.length === 0 ? (
            <p className="text-sm text-gray-500">No driver has deliveries for this date yet.</p>
          ) : (
            <select
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {driverOptions.map((d) => (
                <option key={d._id} value={d._id}>
                  {getDriverDisplayName(d)} ({deliveries.filter((x) => x.driver?._id === d._id).length})
                </option>
              ))}
            </select>
          )}
          <p className="text-[11px] text-gray-500">
            Use the arrows or type a number (1 = first, {order.length || 'N'} = last). This feeds Driver Routes and the driver app.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {order.length === 0 ? (
            <p className="p-4 text-sm text-gray-400">No deliveries to order.</p>
          ) : (
            <ol className="divide-y divide-gray-100">
              {order.map((deliveryId, idx) => {
                const d = byId.get(deliveryId);
                if (!d) return null;
                return (
                  <li key={deliveryId} className="p-3 flex items-center gap-3">
                    <span className="flex flex-col items-center flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => move(deliveryId, -1)}
                        disabled={idx === 0}
                        className="text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed leading-none"
                        title="Move earlier"
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={order.length}
                        value={idx + 1}
                        data-activity-label={`Stop position for ${stopLabel(deliveryId)}`}
                        onChange={(e) => setPosition(deliveryId, Number(e.target.value))}
                        className="w-10 text-center text-xs border border-gray-300 rounded"
                        title="Type the stop number — 1 = first"
                      />
                      <button
                        type="button"
                        onClick={() => move(deliveryId, 1)}
                        disabled={idx === order.length - 1}
                        className="text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed leading-none"
                        title="Move later"
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-gray-900 truncate">{d.customerName || 'Customer'}</span>
                      {d.address ? <span className="block text-xs text-gray-500 truncate">{d.address}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 space-y-2">
          {msg ? (
            <p className={`text-xs ${msg.error ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || order.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
