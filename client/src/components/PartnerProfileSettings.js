import React, {useEffect, useState} from 'react';
import partnerApi from '../utils/partnerApi';
import {PARTNER_BUSINESS_FIELDS, partnerDefaultWindow, partnerDeliveryWindows} from '../utils/partnerProfileSettings';

const fields = partner => Object.fromEntries(PARTNER_BUSINESS_FIELDS.map(([key]) => [key, partner?.[key] || '']));
export default function PartnerProfileSettings({partner, onSaved}) {
  const [form, setForm] = useState(() => ({...fields(partner), defaultDeliveryTime: partnerDefaultWindow(partner)}));
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {setForm({...fields(partner), defaultDeliveryTime: partnerDefaultWindow(partner)});}, [partner]);
  const save = async event => {
    event.preventDefault(); setMessage(''); setSaving(true);
    const original = {...fields(partner), defaultDeliveryTime: partnerDefaultWindow(partner)};
    const updates = Object.fromEntries(Object.entries(form).filter(([key, value]) => value !== original[key]));
    try {const response = await partnerApi.patch('/partner/profile', updates); onSaved(response.data.data); setMessage('Profile saved.');}
    catch(error) {setMessage(error.response?.data?.message || 'Could not save profile.');}
    finally {setSaving(false);}
  };
  return <form onSubmit={save} className="max-w-xl space-y-3 my-5 bg-[#051747] rounded-2xl border border-[#12275e] p-4" aria-label="Business and delivery details">
    <h3 className="font-bold">Business and delivery details</h3>
    {PARTNER_BUSINESS_FIELDS.map(([key, label, type, placeholder]) => <label key={key} className="block text-sm">{label}
      <input name={key} type={type} value={form[key]} placeholder={placeholder} onChange={e => setForm({...form, [key]: e.target.value})}
        className="block w-full mt-1 rounded-xl bg-[#0a1230] border border-[#12275e] p-2 text-[#ede5de]" />
    </label>)}
    <label className="block text-sm">Preferred delivery time<select value={form.defaultDeliveryTime} onChange={e => setForm({...form, defaultDeliveryTime:e.target.value})} className="block w-full mt-1 rounded-xl bg-[#0a1230] border border-[#12275e] p-2">
      {partnerDeliveryWindows(partner).map(slot => <option key={slot}>{slot}</option>)}
    </select></label>
    <p className="text-sm text-[#a8ccf5]">{partner?.weekendsDisabled ? 'Weekend deliveries are disabled for this account.' : 'Sunday deliveries are closed.'}</p>
    {message && <p role="status">{message}</p>}
    <button disabled={saving} className="rounded-full bg-[#bcf679] text-[#051747] px-4 py-2 font-bold">{saving ? 'Saving…' : 'Save business details'}</button>
  </form>;
}
