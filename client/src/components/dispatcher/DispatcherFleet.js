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
  try {
    const request = JSON.parse(sessionStorage.getItem(key));
    return request?.phase === 'commit' && request.operationId && request.command && request.reviewProof ? request : null;
  } catch { return null; }
}

function storeOperation(key, operation) {
  try {
    if (operation) sessionStorage.setItem(key, JSON.stringify(operation));
    else sessionStorage.removeItem(key);
  } catch { /* The workspace still retains the operation for retry. */ }
}

export function usePendingFleetOperation(actor) {
  const key = actor ? 'matter-fleet-operation:' + actor : null;
  const [local, setLocal] = useState(null);
  const pending = key && (local?.key === key ? local.operation : storedOperation(key));
  function setPending(operation) {
    storeOperation(key, operation);
    setLocal({ key, operation });
  }
  return [pending, setPending];
}

export default function DispatcherFleet({ actor, roster, reloadRoster, pending, setPending, onClose, onSaved }) {
  const [fields, setFields] = useState(initial);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const { kind, vehicleId, otherDriverId, otherVehicleId, ongoing } = fields;
  const end = kind === 'end';
  const swap = kind === 'swap';
  const vehicles = roster?.vehicles ?? [];
  const choices = roster?.drivers ?? [];
  const drivers = choices.filter(driver => driver.isActive === true);
  const name = id => staffName(choices.find(driver => String(driver._id) === id));
  const vehicleName = id => vehicles.find(vehicle => vehicle.id === id)?.label || 'Vehicle';
  const canStart = roster?.vehicles && (end || vehicles.length > 0);

  function update(event) {
    if (lock.current) return;
    const { name, value, checked, type } = event.target;
    setFields(previous => ({
      ...previous,
      [name]: type === 'checkbox' ? checked : value,
      ...(name === 'kind' && value !== 'end' && !drivers.some(driver => String(driver._id) === previous.driverId)
        && { driverId: '' }),
    }));
    setReview(null);
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    if (lock.current || (!pending && !canStart)) return;
    let request = pending;
    if (!request && review) {
      const { operationId, reviewProof, command, expected, expectedAssets } = review;
      request = { phase: 'commit', operationId, reviewProof, command: { ...command, expected, expectedAssets } };
    }
    if (!request) {
      const from = utc(fields.from);
      const to = end || ongoing ? null : utc(fields.to);
      if (!from || (!end && !ongoing && (!to || to <= from))) {
        setError('Choose an effective time and a shift end after it.');
        return;
      }
      const pairs = [{ driverId: fields.driverId, sourceVehicleId: end ? null : vehicleId }];
      if (swap) pairs.push({ driverId: otherDriverId, sourceVehicleId: otherVehicleId });
      request = { phase: 'review', command: { kind, from, to, pairs } };
    }
    const committing = request.phase === 'commit';
    lock.current = true;
    setBusy(true);
    setError('');
    if (committing && !pending) setPending(request);
    try {
      const { data: { data } } = await api.post('/dispatcher-fleet', request, {
        timeout: 10_000, headers: { 'x-matter-fleet-actor': actor },
      });
      if (committing) {
        if (data?.state !== 'saved' || data.operationId !== request.operationId) {
          throw new Error('Vehicle save could not be confirmed. Retry this same request.');
        }
        setPending(null);
        onSaved('Vehicle pairing saved.');
      } else setReview({ ...data, command: request.command });
    } catch (failure) {
      if (committing && [400, 409, 422].includes(failure.response?.status)) {
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
        {roster?.error && <p className="dp-error" role="alert">{roster.error} <button type="button" onClick={reloadRoster}>Retry vehicle options</button></p>}
        {roster?.loading && <p role="status">Loading vehicle options…</p>}
        {!end && roster?.vehicles?.length === 0 && <p role="status">No confirmed vehicles are available.</p>}
        <label className="dp-field">Action<select name="kind" value={kind} onChange={update} disabled={busy}>
          <option value="assign">Assign vehicle</option><option value="swap">Swap two vehicles</option>
          <option value="end">End assignment</option>
        </select></label>
        <label className="dp-field">Driver<select name="driverId" value={fields.driverId} onChange={update} required disabled={busy}>
          <option value="">Choose a driver</option>
          {(end ? choices : drivers).map(driver => <option key={driver._id} value={driver._id}>
            {staffName(driver)}{driver.isActive === false ? ' · Inactive' : ''}
          </option>)}
        </select></label>
        {!end && <label className="dp-field">Vehicle<select name="vehicleId" value={vehicleId} onChange={update} required disabled={busy}>
          <option value="">Choose a vehicle</option>
          {vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.label} · {vehicle.type}</option>)}
        </select></label>}
        {swap && <>
          <label className="dp-field">Second driver<select name="otherDriverId" value={otherDriverId} onChange={update} required disabled={busy}>
            <option value="">Choose a driver</option>
            {drivers.filter(item => String(item._id) !== fields.driverId).map(item =>
              <option key={item._id} value={item._id}>{staffName(item)}</option>)}
          </select></label>
          <label className="dp-field">Second vehicle<select name="otherVehicleId" value={otherVehicleId} onChange={update} required disabled={busy}>
            <option value="">Choose a vehicle</option>
            {vehicles.filter(item => item.id !== vehicleId).map(item =>
              <option key={item.id} value={item.id}>{item.label} · {item.type}</option>)}
          </select></label>
        </>}
        <label className="dp-field">Effective time in Dubai
          <input type="datetime-local" name="from" value={fields.from} onChange={update} required disabled={busy} />
        </label>
        {!end && <>
          <label><input type="checkbox" name="ongoing" checked={ongoing} onChange={update} disabled={busy} /> Ongoing custody</label>
          {!ongoing && <label className="dp-field">Shift end in Dubai
            <input type="datetime-local" name="to" value={fields.to} onChange={update} required disabled={busy} />
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
        <button type="submit" className="primary" disabled={busy || (!pending && !canStart)}>
          {busy ? 'Working…' : pending ? 'Retry save' : review ? 'Save pairing' : 'Review pairing'}
        </button>
      </div>
    </form>
  </DispatcherDialog>;
}
