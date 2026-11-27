import React, { useRef, useState } from 'react';
import api from '../../utils/api';
import { businessComponentsToUtcDate, formatBusinessDateInput, formatBusinessDateTime, formatBusinessTimeInput } from '../../utils/businessTime';
import { errorMessage, staffName } from '../../utils/dispatcher';
import { DispatcherDialog } from './DispatcherFilters';

function initial() {
  const now = new Date();
  return { kind: 'assign', driverId: '', vehicleId: '', otherDriverId: '', otherVehicleId: '',
    from: formatBusinessDateInput(now) + 'T' + formatBusinessTimeInput(now), to: '', ongoing: false };
}
const utc = value => {
  const [date, time] = value.split('T');
  return businessComponentsToUtcDate(date, time)?.toISOString();
};

function storedOperation(key) {
  try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
}

function storeOperation(key, operation) {
  try {
    if (operation) sessionStorage.setItem(key, JSON.stringify(operation));
    else sessionStorage.removeItem(key);
  } catch { /* The current dialog still retains the operation for retry. */ }
}

export default function DispatcherFleet({ actor, drivers, vehicles, onClose, onSaved }) {
  const key = 'matter-fleet-operation:' + actor;
  const [fields, setFields] = useState(initial);
  const [review, setReview] = useState(null);
  const [pending, setPending] = useState(() => storedOperation(key));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const name = id => staffName(drivers.find(driver => String(driver._id) === id)) || 'Driver';
  const vehicleName = id => vehicles.find(vehicle => vehicle.id === id)?.label || 'Vehicle';
  const { kind, vehicleId, otherDriverId, otherVehicleId, ongoing } = fields;
  const end = kind === 'end';
  const swap = kind === 'swap';

  function update(event) {
    const { name, value, checked, type } = event.target;
    setFields(previous => ({ ...previous, [name]: type === 'checkbox' ? checked : value }));
    setReview(null);
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    if (lock.current) return;
    let request = pending;
    const from = utc(fields.from);
    const to = end || ongoing ? null : utc(fields.to);
    if (!request && (!from || (!end && !ongoing && (!to || to <= from)))) {
      setError('Choose a shift end after the effective time.');
      return;
    }
    if (!request) {
      const pairs = [{ driverId: fields.driverId, sourceVehicleId: end ? null : vehicleId }];
      if (swap) pairs.push({ driverId: otherDriverId, sourceVehicleId: otherVehicleId });
      const command = { kind, from, to, pairs };
      request = review
        ? { phase: 'commit', operationId: review.operationId, reviewProof: review.reviewProof,
          command: { ...command, expected: review.expected, expectedAssets: review.expectedAssets } }
        : { phase: 'review', command };
    }
    const committing = request.phase === 'commit';
    lock.current = true;
    setBusy(true);
    setError('');
    if (committing) {
      setPending(request);
      storeOperation(key, request);
    }
    try {
      const { data: { data } } = await api.post('/dispatcher-fleet', request, { timeout: 6000 });
      if (committing) {
        storeOperation(key, null);
        setPending(null);
        onSaved('Vehicle pairing saved.');
      } else setReview(data);
    } catch (failure) {
      if (committing && [400, 409, 422].includes(failure.response?.status)) {
        storeOperation(key, null);
        setPending(null);
        setReview(null);
      }
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <DispatcherDialog title="Vehicle assignment" busy={busy} onClose={onClose}>
    <form onSubmit={submit}>
      {pending ? <p role="status">This save is unconfirmed. Retry to check or finish the original save.</p> : <>
        <label className="dp-field">Action<select name="kind" value={kind} onChange={update}>
          <option value="assign">Assign vehicle</option><option value="swap">Swap two vehicles</option>
          <option value="end">End assignment</option>
        </select></label>
        <label className="dp-field">Driver<select name="driverId" value={fields.driverId} onChange={update} required>
          <option value="">Choose a driver</option>
          {drivers.map(driver => <option key={driver._id} value={driver._id}>{staffName(driver)}</option>)}
        </select></label>
        {!end && <label className="dp-field">Vehicle<select name="vehicleId" value={vehicleId} onChange={update} required>
          <option value="">Choose a vehicle</option>
          {vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.label} · {vehicle.type}</option>)}
        </select></label>}
        {swap && <>
          <label className="dp-field">Second driver<select name="otherDriverId" value={otherDriverId} onChange={update} required>
            <option value="">Choose a driver</option>
            {drivers.filter(item => String(item._id) !== fields.driverId).map(item =>
              <option key={item._id} value={item._id}>{staffName(item)}</option>)}
          </select></label>
          <label className="dp-field">Second vehicle<select name="otherVehicleId" value={otherVehicleId} onChange={update} required>
            <option value="">Choose a vehicle</option>
            {vehicles.filter(item => item.id !== vehicleId).map(item =>
              <option key={item.id} value={item.id}>{item.label} · {item.type}</option>)}
          </select></label>
        </>}
        <label className="dp-field">Effective time in Dubai
          <input type="datetime-local" name="from" value={fields.from} onChange={update} required />
        </label>
        {!end && <>
          <label><input type="checkbox" name="ongoing" checked={ongoing} onChange={update} /> Ongoing custody</label>
          {!ongoing && <label className="dp-field">Shift end in Dubai
            <input type="datetime-local" name="to" value={fields.to} onChange={update} required />
          </label>}
        </>}
        {review?.current.length > 0 && <div>
          <p>This change will end or replace these pairings.</p>
          <ul>{review.current.map(row => <li key={row.id}>
            {name(row.driverId)} · {vehicleName(row.sourceVehicleId)} · {formatBusinessDateTime(row.from)}
          </li>)}</ul>
        </div>}
      </>}
      {error && <p className="dp-error" role="alert">{error}</p>}
      <div className="dp-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Working…' : pending ? 'Retry save' : review ? 'Save pairing' : 'Review pairing'}
        </button>
      </div>
    </form>
  </DispatcherDialog>;
}
