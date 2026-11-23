import React, { useState } from 'react';
import api from '../../utils/api';
import { DispatcherDialog } from './DispatcherFilters';
import { businessComponentsToUtcDate, formatBusinessDateInput, formatBusinessTimeInput, formatBusinessTime } from '../../utils/businessTime';
import { getDeliveryLatLng } from '../../utils/deliveryCoords';
import { errorMessage, driverId, staffName, isFinished, proofImageUrl } from '../../utils/dispatcher';
export const dateLabel = value => value ? new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: 'Asia/Dubai'
}).format(new Date(value)) : 'Not recorded';
export const timestamp = value => value ? new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Dubai'
}).format(new Date(value)) : 'Not recorded';
export const Cell = ({
  label,
  value
}) => <div><small>{label}</small><strong>{value || 'Not recorded'}</strong></div>;
export function DeliveryDetails({
  delivery: d,
  drivers,
  onEdit,
  onAssign,
  onUnassign
}) {
  const [proof, setProof] = useState('');
  const pin = getDeliveryLatLng(d),
    finished = isFinished(d),
    driver = typeof d.driver === 'object' ? d.driver : drivers.find(x => String(x._id) === driverId(d.driver));
  const photos = [...new Set([...(d.proof?.images || []), d.proof?.photoUrl, d.collectionDetails?.collectedPhotoUrl].map(url => proofImageUrl(url, api.defaults?.baseURL)).filter(Boolean))];
  const ad = d.addressDetails || {};
  const items = typeof d.items === 'string' ? d.items : Array.isArray(d.items) ? d.items.map(i => typeof i === 'string' ? i : i.name || i.itemName || 'Item').join(', ') : '';
  return <><p className={`dp-pill ${d.status}`}>{String(d.status || 'pending').replaceAll('_', ' ')}</p><section className="dp-detail-section"><h3>Customer information</h3><div className="dp-detail-grid"><Cell label="Customer ID" value={d.customerId} /><Cell label="Phone" value={d.customerPhone} /></div>{d.customerPhone && <a className="dp-call" href={`tel:${d.customerPhone}`}>Call customer</a>}</section><section className="dp-detail-section"><h3>Delivery location</h3><p>{d.address || 'Address not recorded'}</p><div className="dp-detail-grid">{[['Label', ad.label], ['Emirate', ad.city], ['Zone', d.zone || ad.area], ['Building', ad.building], ['Unit', ad.unit || ad.apartment], ['Floor', ad.floor], ['Address status', ad.addressStatus]].filter(([, v]) => v).map(([label, value]) => <Cell key={label} {...{
          label,
          value
        }} />)}</div>{d.combinedSunday && <p className="dp-help">Sunday meals are included with this Saturday delivery.</p>}</section><section className="dp-detail-section"><h3>Saved pin location</h3>{pin ? <div className="dp-detail-grid"><Cell label="Latitude" value={pin.lat.toFixed(6)} /><Cell label="Longitude" value={pin.lng.toFixed(6)} /></div> : <p className="dp-warning">No saved pin. Request an exact location before dispatch.</p>}</section><section className="dp-detail-section"><h3>Timing details</h3><div className="dp-detail-grid"><Cell label="Scheduled date" value={dateLabel(d.scheduledTime)} /><Cell label="Scheduled time · Dubai" value={formatBusinessTime(d.scheduledTime)} /><Cell label="Delivered at" value={d.deliveredTime || d.completedAt ? timestamp(d.deliveredTime || d.completedAt) : 'Awaiting completion'} /><Cell label="Timing result" value={d.lateMinutes > 0 ? `${d.lateMinutes} minutes late` : d.earlyMinutes > 0 ? `${d.earlyMinutes} minutes early` : d.deliveredTime ? 'On time' : 'Awaiting delivery'} /></div></section><section className="dp-detail-section"><h3>Driver assignment</h3><p>{driver ? staffName(driver) : 'Unassigned'}</p></section>{photos.length > 0 && <section className="dp-detail-section"><h3>Proof of delivery</h3><div className="dp-proof">{photos.map((src, i) => <button key={src} onClick={() => setProof(src)} aria-label={`Enlarge proof ${i + 1}`}><img src={src} alt={`Delivery proof ${i + 1}`} /></button>)}</div></section>}<section className="dp-detail-section"><h3>Order details</h3><p>{items || 'No items recorded'}</p>{d.weight && <p className="dp-help">Weight: {d.weight} kg</p>}{d.dimensions && <p className="dp-help">Dimensions: {typeof d.dimensions === 'string' ? d.dimensions : Object.values(d.dimensions).join(' × ')}</p>}</section><section className="dp-detail-section"><h3>Special instructions</h3><p>{d.notes || 'No special instructions'}</p></section><section className="dp-detail-section"><h3>Delivery timeline</h3><ol className="dp-timeline">{(d.timeline || []).map((event, i) => <li key={i}><strong>{String(event.status || 'Updated').replaceAll('_', ' ')}</strong><small>{timestamp(event.timestamp)}</small><p>{event.notes}</p></li>)}</ol>{!d.timeline?.length && <p>No timeline events recorded.</p>}</section><div className="dp-actions"><button onClick={() => onEdit(d)}>Edit delivery</button>{!finished && <button className="primary" onClick={() => onAssign([d])}>{d.driver ? 'Reassign' : 'Assign'} driver</button>}{d.driver && !finished && <button onClick={() => onUnassign([d])}>Unassign</button>}</div>{proof && <DispatcherDialog title="Delivery proof" onClose={() => setProof('')}><img className="dp-large-proof" src={proof} alt="Delivery proof" /></DispatcherDialog>}</>;
}
export function DispatcherDeliveryForm({
  delivery: d,
  date,
  onSaved,
  onClose
}) {
  const pin = getDeliveryLatLng(d);
  const [form, setForm] = useState({
    customerName: d?.customerName || '',
    customerId: d?.customerId || '',
    customerPhone: d?.customerPhone || '',
    address: d?.address || '',
    zone: d?.zone || '',
    emirate: d?.addressDetails?.city || '',
    date: d ? formatBusinessDateInput(d.scheduledTime) : date,
    time: d ? formatBusinessTimeInput(d.scheduledTime) : '07:00',
    type: d?.type || 'Delivery',
    notes: d?.notes || '',
    latitude: pin?.lat ?? '',
    longitude: pin?.lng ?? ''
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const change = (key, value) => setForm(f => ({
    ...f,
    [key]: value,
    ...(key === 'address' && value !== d?.address ? {
      latitude: '',
      longitude: ''
    } : {})
  }));
  const save = async e => {
    e.preventDefault();
    setError('');
    if (form.latitude === '' !== (form.longitude === '')) {
      setError('Enter both latitude and longitude or leave both empty.');
      return;
    }
    const scheduled = businessComponentsToUtcDate(form.date, form.time);
    if (!scheduled) {
      setError('Choose a valid date and time.');
      return;
    }
    const addressChanged = form.address.trim() !== String(d?.address || '').trim();
    const pinChanged = String(form.latitude) !== String(pin?.lat ?? '') || String(form.longitude) !== String(pin?.lng ?? '') || addressChanged;
    const payload = {
      customerName: form.customerName.trim(),
      customerId: form.customerId.trim(),
      customerPhone: form.customerPhone.trim(),
      address: form.address.trim(),
      zone: form.zone.trim(),
      type: form.type,
      notes: form.notes,
      scheduledTime: scheduled.toISOString(),
      addressDetails: {
        ...(addressChanged ? {} : d?.addressDetails || {}),
        city: form.emirate.trim()
      }
    };
    if (pinChanged) {
      const coords = form.latitude !== '' ? {
        lat: Number(form.latitude),
        lng: Number(form.longitude)
      } : null;
      Object.assign(payload, {
        gpsLocation: coords,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        location: null,
        coordinates: null,
        latitude: null,
        longitude: null,
        mapsUrl: ''
      });
      payload.addressDetails.coordinates = coords;
    }
    setBusy(true);
    try {
      if (d) await api.put(`/deliveries/${d._id}`, payload);else await api.post('/deliveries', payload);
      onSaved(form.date);
    } catch (e2) {
      setError(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };
  const field = (key, label, type = 'text', required = false, attrs = {}) => <label className="dp-field" key={key}>{label}<input type={type} value={form[key]} required={required} disabled={busy} onChange={e => change(key, e.target.value)} {...attrs} /></label>;
  return <DispatcherDialog title={d ? 'Edit delivery' : 'New delivery'} busy={busy} onClose={onClose}><form className="dp-form" onSubmit={save}>{field('customerName', 'Customer name', 'text', true)}{field('customerId', 'Customer ID', 'text', true)}{field('customerPhone', 'Phone number', 'tel')}<label className="dp-field">Type<select value={form.type} disabled={busy} onChange={e => change('type', e.target.value)}>{['Delivery', 'Collection', 'Task'].map(v => <option key={v}>{v}</option>)}</select></label>{field('address', 'Address', 'text', form.type !== 'Collection')}{field('zone', 'Zone')}{field('emirate', 'Emirate')}{field('date', 'Delivery date', 'date', true)}{field('time', 'Scheduled time · Dubai', 'time', true)}{field('latitude', 'Saved latitude (optional)', 'number', false, {
        min: -90,
        max: 90,
        step: 'any'
      })}{field('longitude', 'Saved longitude (optional)', 'number', false, {
        min: -180,
        max: 180,
        step: 'any'
      })}<label className="dp-field dp-wide">Special instructions<textarea value={form.notes} disabled={busy} onChange={e => change('notes', e.target.value)} /></label><p className="dp-help dp-wide">Changing the address clears the old pin. Enter exact coordinates to save a new pin.</p>{error && <p className="dp-error dp-wide" role="alert">{error}</p>}<div className="dp-actions dp-wide"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : d ? 'Save changes' : 'Create delivery'}</button></div></form></DispatcherDialog>;
}
