import React from 'react';
import { parseGPSFromLink } from '../utils/gpsParsing';
import { recordActivityChange } from '../utils/activityCapture';

export default function DeliveryAddressFields({ value, onChange, inputCls, labelCls }) {
  const update = patch => onChange({ ...value, ...patch });
  const villa = value.category === 'villa';
  const observe = (field, before, after, element) => recordActivityChange({ field, form: 'Delivery address', before: before ?? '', after: after ?? '', element });
  const field = (key, label, required = true) => (
    <div key={key}>
      <label className={labelCls} htmlFor={`delivery-address-${key}`}>{label}{required ? ' *' : ''}</label>
      <input id={`delivery-address-${key}`} value={value[key] || ''} required={required}
        onChange={e => update({ [key]: e.target.value })} className={inputCls} />
    </div>
  );
  return <>
    <fieldset className="md:col-span-2">
      <legend className={labelCls}>Category *</legend>
      <div className="flex flex-wrap gap-5">
        {['villa', 'apartment', 'office'].map(category => <label key={category} className="flex items-center gap-2 text-sm">
          <input type="radio" name="delivery-address-category" value={category} required
            checked={value.category === category}
            onChange={event => {
              observe('Building Name', value.building, '', event.currentTarget);
              observe('Floor', value.floor, '', event.currentTarget);
              observe(villa ? 'Villa Number' : 'Apartment Number', value.unit, '', event.currentTarget);
              update({ category, building: '', floor: '', unit: '' });
            }} />
          {category[0].toUpperCase() + category.slice(1)}
        </label>)}
      </div>
    </fieldset>
    {field('area', 'Delivery Zone')}
    {field('street', 'Street')}
    {value.category && <>
      {!villa && field('building', 'Building Name')}
      {!villa && field('floor', 'Floor')}
      {field('unit', villa ? 'Villa Number' : 'Apartment Number')}
    </>}
    <fieldset className="md:col-span-2 space-y-3">
      <legend className={labelCls}>Pin Location *</legend>
      <label className="block text-sm">Map link (optional)
        <input className={inputCls} value={value.link || ''} placeholder="Paste a map link or enter coordinates below"
          onChange={e => {
            const link = e.target.value;
            const pin = parseGPSFromLink(link);
            observe('Latitude', value.coordinates?.lat, pin?.lat ?? '', e.currentTarget);
            observe('Longitude', value.coordinates?.lng, pin?.lng ?? '', e.currentTarget);
            update({ link, coordinates: pin ? { lat: pin.lat, lng: pin.lng } : { lat: '', lng: '' } });
          }} />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {['lat', 'lng'].map(key => <label key={key} className="text-sm">{key === 'lat' ? 'Latitude' : 'Longitude'} *
          <input type="number" step="any" required min={key === 'lat' ? -90 : -180} max={key === 'lat' ? 90 : 180}
            className={inputCls} value={value.coordinates?.[key] ?? ''}
            onChange={e => {
              observe('Map link', value.link, '', e.currentTarget);
              update({ link: '', coordinates: { ...value.coordinates, [key]: e.target.value } });
            }} />
        </label>)}
      </div>
      <p className="text-xs text-gray-500">If the link does not contain coordinates, enter the exact pin latitude and longitude.</p>
    </fieldset>
    <div className="md:col-span-2">
      <label className={labelCls} htmlFor="delivery-additional-details">Additional Details</label>
      <textarea id="delivery-additional-details" className={inputCls} rows={2} value={value.additional_details || ''}
        onChange={e => update({ additional_details: e.target.value })} />
    </div>
  </>;
}
