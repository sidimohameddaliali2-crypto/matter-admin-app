import React, { useRef, useState } from 'react';
import api from '../../utils/api';
import { errorMessage, staffName } from '../../utils/dispatcher';
import { DispatcherDialog } from './DispatcherFilters';

const initial = { kind: 'assign', driverId: '', vehicleId: '' };

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
  const { kind, driverId, vehicleId } = fields;
  const end = kind === 'end';
  const swap = kind === 'swap';
  const rosterVehicles = roster?.vehicles ?? [];
  const choices = roster?.drivers ?? [];
  const name = id => staffName(choices.find(driver => String(driver._id) === id));
  const vehicleName = id => rosterVehicles.find(vehicle => vehicle.id === id)?.label || 'Vehicle';
  const held = id => rosterVehicles.find(vehicle => vehicle.driverId === id);
  const active = choices.filter(driver => driver.isActive === true);
  const drivers = end ? choices.filter(driver => held(driver._id)) : active;
  const currentVehicle = held(driverId);
  const vehicles = rosterVehicles.filter(vehicle => vehicle.available && (swap
    ? currentVehicle?.available && vehicle.driverId && vehicle.driverId !== driverId
      && active.some(driver => driver._id === vehicle.driverId)
    : !vehicle.driverId || vehicle.driverId === driverId));
  const selectedVehicle = vehicles.find(vehicle => vehicle.id === vehicleId);
  const canStart = drivers.some(driver => driver._id === driverId) && Boolean(end || selectedVehicle);

  function update(event) {
    if (lock.current) return;
    const { name, value } = event.target;
    setFields(previous => ({
      ...previous,
      [name]: value,
      ...(name === 'kind' && { driverId: '' }),
      ...(name !== 'vehicleId' && { vehicleId: '' }),
    }));
    setReview(null);
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    if (lock.current || (!pending && !canStart)) return;
    let request = pending;
    if (!request && review) {
      const { operationId, reviewProof, command } = review;
      request = { phase: 'commit', operationId, reviewProof, command };
    }
    if (!request) {
      const pairs = [{ driverId, sourceVehicleId: end ? null : vehicleId }];
      if (swap) pairs.push({ driverId: selectedVehicle.driverId, sourceVehicleId: currentVehicle.id });
      request = { phase: 'review', command: { kind, pairs } };
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
      } else {
        if (!Array.isArray(data?.changes) || !data.changes.length || !data.operationId || !data.reviewProof) {
          throw new Error('Vehicle pairing could not be reviewed. Try again.');
        }
        setReview({ ...data, command: request.command });
      }
    } catch (failure) {
      if (failure.response?.status === 409) reloadRoster();
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
        {!end && roster?.vehicles && vehicles.length === 0 && (!swap || driverId)
          && <p role="status">{swap ? 'This driver has no available reciprocal swap.' : 'No confirmed vehicles are available.'}</p>}
        <label className="dp-field">Action<select name="kind" value={kind} onChange={update} disabled={busy}>
          <option value="assign">Assign vehicle</option><option value="swap">Swap two vehicles</option>
          <option value="end">End assignment</option>
        </select></label>
        <label className="dp-field">Driver<select name="driverId" value={driverId} onChange={update} required disabled={busy}>
          <option value="">Choose a driver</option>
          {drivers.map(driver => <option key={driver._id} value={driver._id}>
            {staffName(driver)}{driver.isActive === false ? ' · Inactive' : ''}
          </option>)}
        </select></label>
        {!end && <label className="dp-field">Vehicle<select name="vehicleId" value={vehicleId} onChange={update} required disabled={busy || !driverId}>
          <option value="">Choose a vehicle</option>
          {vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>
            {vehicle.label} · {vehicle.type}{swap ? ' · ' + name(vehicle.driverId) : ''}
          </option>)}
        </select></label>}
        {swap && selectedVehicle && <p>{currentVehicle.label} goes to {name(selectedVehicle.driverId)}.</p>}
        {review && <div>
          <p>This change takes effect when saved.</p>
          <ul>{review.changes.map(change => <li key={change.sourceVehicleId}>
            {vehicleName(change.sourceVehicleId)} · {change.driverId ? name(change.driverId) : 'Unassigned'}
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
