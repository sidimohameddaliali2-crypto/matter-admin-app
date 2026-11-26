import React, { useEffect, useState } from 'react';
import { Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import api from '../../utils/api';

export default function YellowblockBulkAssignment({ orders, onClose, onResult }) {
  const [couriers, setCouriers] = useState(null);
  const [courierId, setCourierId] = useState('');
  const [loadingError, setLoadingError] = useState('');
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState([]);

  useEffect(() => {
    const controller = new AbortController();
    api.get('/yellowblock/kitchen/couriers', { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setCouriers(data.data);
    }).catch(requestError => {
      if (!controller.signal.aborted) setLoadingError(requestError.response?.data?.message || 'Could not load couriers.');
    });
    return () => controller.abort();
  }, [reload]);

  const assign = async event => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setFailed([]);
    try {
      const { data: { data: result } } = await api.patch('/yellowblock/kitchen/courier-assignments', {
        orderIds: orders.map(order => String(order.id)), courierId,
      });
      setFailed(result.failed);
      onResult(result);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not confirm the assignment. Check the orders or try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? undefined : onClose} disableEscapeKeyDown={saving} fullWidth maxWidth="xs" aria-labelledby="yellowblock-assignment-title"
      PaperProps={{ className: 'yb-assignment-dialog' }}>
      <form onSubmit={assign}>
        <DialogTitle id="yellowblock-assignment-title">Assign {orders.length} {orders.length === 1 ? 'order' : 'orders'}</DialogTitle>
        <DialogContent dividers>
          <p className="mb-3 max-h-20 overflow-y-auto text-sm text-gray-600">{orders.map(order => order.name).join(', ')}</p>
          {loadingError ? (
            <p role="alert" className="text-sm text-red-800">{loadingError}{' '}
              <button type="button" className="font-semibold underline" onClick={() => { setLoadingError(''); setReload(value => value + 1); }}>Retry</button>
            </p>
          ) : !couriers ? <p role="status" className="text-sm text-gray-600">Loading couriers…</p> : (
            <label className="block text-sm font-semibold" htmlFor="yellowblock-bulk-courier">
              Courier or driver
              <select id="yellowblock-bulk-courier" className="mt-1 block min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm"
                value={courierId} onChange={event => setCourierId(event.target.value)} disabled={saving}>
                <option value="">Choose a courier</option>
                {couriers.map(courier => <option key={courier.id} value={courier.id}>{courier.name}</option>)}
              </select>
            </label>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
          {failed.length > 0 && (
            <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
              <p className="font-semibold">{failed.length} {failed.length === 1 ? 'order needs' : 'orders need'} attention</p>
              <ul className="mt-1 max-h-36 overflow-y-auto">
                {failed.map(({ orderId, message }) => (
                  <li key={orderId}>{orders.find(order => String(order.id) === orderId)?.name || orderId} · {message}</li>
                ))}
              </ul>
            </div>
          )}
        </DialogContent>
        <DialogActions className="yb-assignment-actions">
          <button type="button" className="yb-button yb-button-secondary" onClick={onClose} disabled={saving}>Close</button>
          <button type="submit" className="yb-button yb-button-primary" disabled={saving || !courierId || !orders.length}>
            {saving ? 'Assigning…' : 'Confirm assignment'}
          </button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
