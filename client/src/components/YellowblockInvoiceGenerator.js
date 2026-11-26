import React, { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText } from 'lucide-react';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';

const categoryNames = ['Cheeses', 'Accompaniments', 'Accessories', 'Florals'];
const menuOptions = {
  Cheeses: ['Parmigiano Reggiano', 'Wensleydale Cranberry Cheese', 'Manchego', 'Chili Manchego', '24 Month Aged Comté', 'Truffle Cheddar', 'Tête de Moine', 'Brie with Honey & Bresaola', 'Gorgonzola and Honey'],
  Accompaniments: ['Olives', 'Cured Meat', 'Assorted Mixed Nuts', 'Crackers & Crunch', 'Bread & Bread Sticks', 'Red Grapes', 'Figs', 'Blackberries', 'Tomatoes', 'Pomegranate', 'Raspberries'],
  Accessories: ['Stone Servewares', 'Stone Accessories', 'Custom Made Stonewares', 'Candles and Candle Holders', 'Elevations', 'Serving Utensils'],
  Florals: ['Maroon Anthurium, Hydrangea and Amaranthus Arrangements', 'Tomato garlands, red hydrangea and small red chrysanthemums'],
};
const currency = new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED' });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const inputClass = 'mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900';
const linkClass = 'inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-orange-50';

const initialDraft = () => ({
  invoiceNumber: '', customer: '', address: '', telephone: '', customerTrn: '', eventDate: '', invoiceDate: today(), handling: '', installation: '',
  packagePrice: '', installationPrice: '', floralBilling: 'included',
  enabled: { packagePrice: false, handling: false, handlingPrice: false, installationPrice: false },
  categories: Object.fromEntries(categoryNames.map(name => [name, { enabled: true, priceEnabled: false, details: '', price: '' }])),
});

const detailFields = [
  ['invoiceNumber', 'Invoice number', { maxLength: 30, pattern: '[A-Za-z0-9_\\/\\-]+' }],
  ['customer', 'Customer name', { maxLength: 120 }],
  ['invoiceDate', 'Invoice date', { type: 'date' }],
  ['eventDate', 'Event date', { type: 'date' }],
  ['address', 'Address', { rows: 2, maxLength: 300 }],
  ['telephone', 'Telephone', { type: 'tel', maxLength: 40 }],
  ['customerTrn', 'Customer TRN', { inputMode: 'numeric', pattern: '[0-9]+', maxLength: 25 }],
];

function cents(price) {
  const number = /^(\d{0,7})(?:\.(\d{1,2}))?$/.exec(price);
  return number ? Number(number[1]) * 100 + Number((number[2] || '').padEnd(2, '0')) : 0;
}

function PriceField({ label, value, onChange }) {
  return (
    <label className="block text-sm font-semibold text-gray-700">
      {label}
      <input type="number" inputMode="decimal" min="0" max="9999999.99" step="0.01" placeholder="0.00" className={inputClass}
        value={value} onChange={event => onChange(event.target.value)} />
    </label>
  );
}

function IncludeField({ label, checked, onChange, children }) {
  return (
    <div className="space-y-2">
      <label className="flex min-h-8 items-center gap-2 text-sm font-semibold text-gray-700">
        <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="h-5 w-5 accent-[#a23119]" />
        {label}
      </label>
      {checked && children}
    </div>
  );
}

export default function YellowblockInvoiceGenerator() {
  const [draft, setDraft] = useState(initialDraft);
  const [pdf, setPdf] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(null);
  const separateFlorals = draft.categories.Florals.enabled && draft.floralBilling === 'separate';
  const price = name => draft.enabled[name] !== false ? cents(draft[name]) : 0;
  const categoryPrice = name => {
    const item = draft.categories[name];
    return item.enabled && item.priceEnabled ? cents(item.price) : 0;
  };
  const service = price('packagePrice') + (draft.enabled.installation !== false ? price('installationPrice') : 0)
    + categoryNames.reduce((sum, name) => sum + (separateFlorals && name === 'Florals' ? 0 : categoryPrice(name)), 0);
  const floral = separateFlorals ? categoryPrice('Florals') : 0;
  const subtotal = service + floral + (draft.enabled.handling && draft.enabled.handlingPrice ? cents(draft.handling) : 0);
  const vat = Math.floor((subtotal + 10) / 20);

  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url); }, [pdf]);
  useEffect(() => () => request.current?.abort(), []);

  const edit = update => {
    setDraft(update);
    setPdf(null);
    setError('');
  };
  const setField = (name, value) => edit(current => ({ ...current, [name]: value }));
  const setEnabled = (name, value) => edit(current => ({ ...current, enabled: { ...current.enabled, [name]: value } }));
  const setCategory = (name, field, value) => edit(current => ({
    ...current, categories: { ...current.categories, [name]: { ...current.categories[name], [field]: value } },
  }));
  const addMenuItem = (name, item) => {
    const existing = draft.categories[name].details;
    if (!item || existing.split(/\r?\n/).some(line => line.trim().toLowerCase() === item.toLowerCase())) return;
    recordActivityChange({ field: `${name} menu item`, form: 'Yellow Block invoice', before: '', after: item });
    setCategory(name, 'details', [existing.trimEnd(), item].filter(Boolean).join('\n'));
  };

  const generate = async event => {
    event.preventDefault();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/yellowblock/invoices/pdf', draft, { responseType: 'blob', signal: controller.signal });
      if (controller.signal.aborted) return;
      const number = draft.enabled.invoiceNumber !== false ? draft.invoiceNumber.trim().replaceAll('/', '-') : '';
      const filename = `Yellow-Block-invoice${number ? `-${number}` : ''}.pdf`;
      setPdf({ url: URL.createObjectURL(data), filename });
    } catch (requestError) {
      const body = requestError.response?.data;
      let message = 'Could not generate the invoice PDF. Try again.';
      if (body instanceof Blob && body.type.includes('json')) {
        try { message = JSON.parse(await body.text()).message || message; } catch { /* Keep the default message. */ }
      }
      if (!controller.signal.aborted) setError(message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const optionalPrice = (name, label, valueName = name) => (
    <IncludeField label={`Include ${label.toLowerCase()}`} checked={draft.enabled[name] !== false} onChange={value => setEnabled(name, value)}>
      <PriceField label={`${label} (AED)`} value={draft[valueName]} onChange={value => setField(valueName, value)} />
    </IncludeField>
  );

  return (
    <section className="yb-invoice mx-auto w-full max-w-7xl space-y-5 py-6">
      <header className="yb-invoice-heading">
        <span className="yb-summary-icon yb-summary-icon-peach mb-2"><FileText size={20} aria-hidden="true" /></span>
        <h2>Invoice Generator</h2>
        <p className="text-sm text-gray-700">Choose the details and prices to include in your invoice.</p>
      </header>
      <form onSubmit={generate} className="yb-invoice-layout">
        <div className="min-w-0 space-y-4">
          <fieldset disabled={loading} className="yb-invoice-card grid gap-4 p-4 sm:grid-cols-2">
            <legend className="text-sm font-bold">Customer and event details</legend>
            {detailFields.map(([name, label, props]) => {
              const Field = props.rows ? 'textarea' : 'input';
              return (
                <IncludeField key={name} label={`Include ${label.toLowerCase()}`} checked={draft.enabled[name] !== false} onChange={value => setEnabled(name, value)}>
                  <Field {...props} aria-label={label} value={draft[name]} onChange={event => setField(name, event.target.value)} className={inputClass} />
                </IncludeField>
              );
            })}
          </fieldset>

          <fieldset disabled={loading} className="yb-invoice-card space-y-2 p-4">
            {optionalPrice('packagePrice', 'Graze package price')}
            {draft.enabled.packagePrice && <p className="text-sm text-gray-600">Any section prices you enter are added to the package price.</p>}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            {categoryNames.map(name => (
              <fieldset disabled={loading} key={name} className="yb-invoice-card min-w-0 space-y-3 p-4">
                <IncludeField label={`Include ${name}`} checked={draft.categories[name].enabled} onChange={value => setCategory(name, 'enabled', value)}>
                  {name === 'Florals' && (
                    <label className="block text-sm font-semibold text-gray-700">Floral billing
                      <select value={draft.floralBilling} onChange={event => setField('floralBilling', event.target.value)} className={inputClass}>
                        <option value="included">Included in the graze</option>
                        <option value="separate">Separate floral décor line</option>
                      </select>
                    </label>
                  )}
                  <select aria-label={`Add a menu item to ${name}`} value="" onChange={event => addMenuItem(name, event.target.value)} className={inputClass}>
                    <option value="">Add a menu item</option>
                    {menuOptions[name].map(item => <option key={item} value={item}>{item}</option>)}
                  </select>
                  <textarea aria-label={`${name} items`} placeholder="Add or edit items, one per line" rows={3} maxLength={1500} value={draft.categories[name].details}
                    onChange={event => setCategory(name, 'details', event.target.value)} className={inputClass} />
                  <IncludeField label={`Include ${name} price`} checked={draft.categories[name].priceEnabled} onChange={value => setCategory(name, 'priceEnabled', value)}>
                    <PriceField label={`${name} price (AED)`} value={draft.categories[name].price} onChange={value => setCategory(name, 'price', value)} />
                  </IncludeField>
                </IncludeField>
              </fieldset>
            ))}
          </div>

          <fieldset disabled={loading} className="yb-invoice-card p-4">
            <IncludeField label="Include custom installation" checked={draft.enabled.installation !== false} onChange={value => setEnabled('installation', value)}>
              <textarea aria-label="Custom installation" rows={2} maxLength={1500} placeholder="Describe the installation" value={draft.installation}
                onChange={event => setField('installation', event.target.value)} className={inputClass} />
              {optionalPrice('installationPrice', 'Installation price')}
            </IncludeField>
          </fieldset>

          <fieldset disabled={loading} className="yb-invoice-card p-4">
            <IncludeField label="Include handling, assembly and disassembly" checked={draft.enabled.handling} onChange={value => setEnabled('handling', value)}>
              {optionalPrice('handlingPrice', 'Handling price', 'handling')}
            </IncludeField>
          </fieldset>
        </div>

        <aside className="yb-invoice-card yb-invoice-summary space-y-4 p-4" aria-label="Invoice totals and PDF">
          <h3>Invoice summary</h3>
          <dl className="space-y-2 text-sm tabular-nums" aria-live="polite">
            {separateFlorals && <>
              <div className="flex justify-between gap-3 text-gray-600"><dt>Graze</dt><dd>{currency.format(service / 100)}</dd></div>
              <div className="flex justify-between gap-3 text-gray-600"><dt>Floral décor</dt><dd>{currency.format(floral / 100)}</dd></div>
            </>}
            <div className="flex justify-between gap-3"><dt>Subtotal</dt><dd>{currency.format(subtotal / 100)}</dd></div>
            <div className="flex justify-between gap-3"><dt>VAT (5%)</dt><dd>{currency.format(vat / 100)}</dd></div>
            <div className="flex justify-between gap-3 border-t border-gray-200 pt-2 text-base font-bold"><dt>Final total</dt><dd>{currency.format((subtotal + vat) / 100)}</dd></div>
          </dl>
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={loading} className="yb-button yb-button-primary w-full">
              {loading ? 'Generating…' : 'Generate PDF'}
            </button>
            {pdf && <>
              <a href={pdf.url} target="_blank" rel="noreferrer" className={linkClass}><ExternalLink size={16} aria-hidden="true" /> Preview PDF</a>
              <a href={pdf.url} download={pdf.filename} className={linkClass}><Download size={16} aria-hidden="true" /> Download PDF</a>
            </>}
          </div>
        </aside>
      </form>
    </section>
  );
}
