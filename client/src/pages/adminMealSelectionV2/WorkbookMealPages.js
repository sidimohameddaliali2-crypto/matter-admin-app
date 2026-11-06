import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, ArrowLeft, Upload, FileSpreadsheet, X, Save } from 'lucide-react';
import { Action, Badge, Panel, Tabs, SearchBox, Select, Notice, DataTable, Modal } from './components';
import { CYCLE_DAYS, MEAL_TYPES, mealType, MEAL_FORMATS, mealFormat, COMPONENT_TYPES, dietaryFlags, componentName, parseMealWorkbook } from './workbookMeals';

import WeeklyCycleBoard from './WeeklyCycleBoard';
import ComponentExclusions from './ComponentExclusions';

const BASE = '/admin/meal-selection-v2';
const componentLabel = type => type === 'Sauce 2' ? 'Salad dressing' : type;
const unique = values => [...new Set(values.filter(Boolean))];
const ADAPTATIONS = ['Not reviewed', 'Cannot adapt', 'Can omit', 'Can substitute', 'Alternative preparation'];
const RELATIONSHIPS = ['Not reviewed', 'Separate component', 'Cooked into main item', 'Combined carb and vegetables'];
const Chips = ({ values, tone = 'grey', empty = 'No flags recorded' }) => values.length ? <span className="av2-badges">{values.map(value => <Badge key={value} tone={tone}>{value}</Badge>)}</span> : <small>{empty}</small>;

function PageHeading({ title, subtitle, children }) {
  return <div className="av2-page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="av2-actions">{children}</div></div>;
}

export function WorkbookImport({ onClose, onImport }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const read = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheets = Object.fromEntries(['Meals', 'Components'].filter(name => workbook.Sheets[name]).map(name => [name, XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' })]));
      const meals = parseMealWorkbook(sheets);
      if (!meals.length) throw new Error('The Meals sheet is empty.');
      setResult({ meals, source: file.name });
    } catch (err) { setError(err.message || 'Could not read this workbook.'); }
    finally { setLoading(false); }
  };
  return <Modal title="Import meal cycle" onClose={onClose} footer={<><Action onClick={onClose}>Cancel</Action><Action primary disabled={!result || loading} onClick={() => { onImport(result); onClose(); }}>Replace preview cycle</Action></>}>
    <p>Use the same layout as your April workbook: Meals and Components sheets, linked by Meal ID. Both sauces, categories, exclusions and preparation notes are preserved.</p>
    <label className="av2-upload"><Upload size={20}/><span>Choose workbook<input aria-label="Choose meal cycle workbook" type="file" accept=".xlsx,.xls" onChange={read}/></span></label>
    {loading && <p role="status">Reading both sheets…</p>}
    {error && <div role="alert"><Notice tone="red">{error}</Notice></div>}
    {result && <><Notice tone="green"><strong>{result.meals.length} meals · {result.meals.reduce((sum, m) => sum + m.components.length, 0)} components</strong><p>Matched by Meal ID. This replaces only your local preview cycle.</p></Notice><DataTable headers={['Meal ID', 'Day', 'Meal type', 'Meal name', 'Components']} rows={result.meals.slice(0, 6).map(m => [m.id, m.day, mealType(m) || 'Not selected', m.name, m.components.length])}/><small>Showing the first six meals. All imported meals remain drafts; Supy links and dietary rules need review.</small></>}
  </Modal>;
}

export function MealLibrary({ meals, source, onImport }) {
  const [query, setQuery] = useState(''), [day, setDay] = useState(''), [category, setCategory] = useState(''), [temperature, setTemperature] = useState('');
  const [view, setView] = useState('Meals'), [importing, setImporting] = useState(false);
  const filtered = meals.filter(m => (!day || m.day === day) && (!category || mealType(m) === category) && (!temperature || m.temperature === temperature) && [m.id, m.name, ...m.components.map(c => c.name)].some(value => value.toLowerCase().includes(query.toLowerCase())));
  const stats = [[meals.length, 'Meals in cycle'], [meals.reduce((s, m) => s + m.components.length, 0), 'Component entries'], [meals.filter(m => m.components.some(c => c.type === 'Sauce 2')).length, 'Meals with salad dressing'], ['7', 'Days · shared Day 6 & 7']];
  return <>
    <PageHeading title="Meal & Recipe Planner" subtitle="Your cycle, meal types and component exclusions — together in one place."><Action icon={Upload} onClick={() => setImporting(true)}>Import Excel cycle</Action><Link to={`${BASE}/meals/new`} className="av2-action av2-primary"><Plus size={15}/>Create meal</Link></PageHeading>
    <div className="av2-source-strip"><FileSpreadsheet size={18}/><div><strong>{source}</strong><small>Workbook preview · local edits only · Supy recipe links not verified</small></div><Badge tone="lime">April Cycle 1</Badge></div>
    <div className="av2-stats av2-workbook-stats">{stats.map(([value, label]) => <Panel key={label}><h2>{value}</h2><small>{label}</small></Panel>)}</div>
    <div className="av2-section-bar"><Tabs values={['Meals', 'Components']} value={view} onChange={setView}/><Link className="av2-text-button" to={`${BASE}/weekly-menu`}>View cycle planner →</Link></div>
    <div className="av2-filters"><SearchBox placeholder="Search meal, component or ID..." value={query} onChange={setQuery}/><Select label="All cycle days" values={CYCLE_DAYS} value={day} onChange={setDay}/><Select label="All meal types" values={MEAL_TYPES} value={category} onChange={setCategory}/><Select label="All temperatures" values={['WARM', 'COLD']} value={temperature} onChange={setTemperature}/></div>
    {view === 'Meals' ? <div className="av2-workbook-table"><DataTable headers={['Meal ID / Day', 'Meal type', 'Meal format', 'Temperature', 'Meal name', 'Protein / main item', 'Carb', 'Vegetable', 'Meal sauce', 'Salad dressing', 'Extra sauce / topping', 'Garnish', 'Tags / Combined', 'Preparation / option notes', 'Edit']} rows={filtered.map(m => [<><Link to={`${BASE}/meals/${m.id}`} className="av2-meal-id">{m.id}</Link><small>{m.day}</small></>, <Badge tone="outline">{mealType(m) || 'Not selected'}</Badge>, <Badge tone="lime">{mealFormat(m)}</Badge>, <Badge tone={m.temperature === 'COLD' ? 'blue' : 'amber'}>{m.temperature}</Badge>, <strong>{m.name}</strong>, ...['Main item', 'Carb', 'Vegetable', 'Sauce', 'Sauce 2', 'Extra sauce / topping', 'Garnish'].map(t => componentName(m, t)), <>{m.tags && <Badge tone="lime">{m.tags}</Badge>}<small>Carb + veg: {m.carbCombined || 'Not specified'}</small></>, m.notes || <small>No meal-level notes</small>, <Link className="av2-icon" aria-label={`Edit ${m.id}`} to={`${BASE}/meals/${m.id}`}><Pencil size={16}/></Link>])}/></div>
      : <DataTable headers={['Meal ID / Day', 'Component type', 'Component name', 'Exclusions / dietary flags', 'Preparation / option notes', 'Source cell', 'Edit']} rows={filtered.flatMap(m => m.components.map(c => [<><Link className="av2-meal-id" to={`${BASE}/meals/${m.id}`}>{m.id}</Link><small>{m.day}</small></>, <Badge tone="outline">{componentLabel(c.type)}</Badge>, <strong>{c.name}</strong>, <Chips values={c.exclusions} tone="amber"/>, c.notes || '—', c.sourceCell || '—', <Link className="av2-icon" aria-label={`Edit ${m.id} ${c.type}`} to={`${BASE}/meals/${m.id}`}><Pencil size={16}/></Link>]))}/>}
    <p className="av2-table-hint">{filtered.length} of {meals.length} meals · {view === 'Meals' ? 'Scroll the table horizontally to see all workbook columns.' : 'Each component keeps its own flags and notes.'}</p>
    {importing && <WorkbookImport onClose={() => setImporting(false)} onImport={onImport}/>}
  </>;
}

export function MealComposer({ meal, isNew, onSave }) {
  const [form, setForm] = useState(() => meal ? { ...JSON.parse(JSON.stringify(meal)), mealType: mealType(meal), mealFormat: mealFormat(meal) } : {
    id: `PREVIEW-${Date.now()}`, name: '', day: '', category: '', mealType: '', mealFormat: 'Main', temperature: 'WARM', tags: '', carbCombined: 'No', notes: '', status: 'Draft', components: [],
  });
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  if (!meal && !isNew) return <Notice>Meal not found. <Link to={`${BASE}/meals`}>Return to meals</Link></Notice>;
  const field = (key, value) => { setError(''); setForm(f => ({ ...f, [key]: value })); };
  const componentField = (id, key, value) => { setError(''); setForm(f => ({ ...f, components: f.components.map(c => c.id === id ? { ...c, [key]: value } : c) })); };
  const save = () => {
    if (!form.name.trim()) return setError('Enter a meal name.');
    if (form.mealFormat === 'Main' && !MEAL_TYPES.includes(form.mealType)) return setError('Choose Chicken, Beef or Fish for a main meal.');
    if (!form.components.length || form.components.some(c => !c.name.trim())) return setError('Add at least one named component.');
    if (form.components.some(c => c.adaptation === 'Can substitute' && !c.replacement.trim())) return setError('Enter an alternative for every component marked Can substitute.');
    if (form.components.some(c => c.type === 'Extra sauce / topping' && !form.components.some(target => target.id === c.attachedComponentId && ['Protein', 'Breakfast', 'Snack', 'Carb', 'Vegetable'].includes(target.type)))) return setError('Choose a component for each extra sauce / topping.');
    onSave({ ...form, name: form.name.trim(), status: 'Draft', components: form.components.map(c => c.type === 'Sauce 2' ? { ...c, saladComponentId: c.saladComponentId || form.components.find(item => item.type === 'Vegetable')?.id || '' } : c) });
  };
  const flags = dietaryFlags(form);
  const renderComponent = (c) => { const index = form.components.findIndex(item => item.id === c.id); return <Panel className="av2-component-panel" key={c.id} title={<span><span className="av2-step">{index + 1}</span>{componentLabel(c.type)}</span>} actions={<button className="av2-icon" aria-label={`Remove ${c.type} component ${index + 1}`} onClick={() => field('components', form.components.filter(v => v.id !== c.id))}><X size={16}/></button>}>
        <div className="av2-form-grid"><label>Component type<select value={c.type} onChange={e => componentField(c.id, 'type', e.target.value)}>{unique([...COMPONENT_TYPES, c.type]).map(t => <option key={t}>{componentLabel(t)}</option>)}</select></label><label>Component / recipe name<input value={c.name} onChange={e => componentField(c.id, 'name', e.target.value)}/></label></div>
        <ComponentExclusions values={c.exclusions} componentName={c.name || componentLabel(c.type)} onChange={values => componentField(c.id, 'exclusions', values)}/>
        <label className="av2-field">Preparation / option notes<textarea aria-label="Preparation / option notes" value={c.notes} rows={2} onChange={e => componentField(c.id, 'notes', e.target.value)} placeholder="Original wording from the Components sheet"/></label>
        {c.type === 'Sauce 2' && <label className="av2-field">Salad / vegetable component<select value={c.saladComponentId || form.components.find(item => item.type === 'Vegetable')?.id || ''} onChange={e => componentField(c.id, 'saladComponentId', e.target.value)}><option value="">Choose salad / vegetables...</option>{form.components.filter(item => item.type === 'Vegetable').map(item => <option key={item.id} value={item.id}>{item.name || 'Unnamed salad / vegetables'}</option>)}</select><small>Salad dressing · imported from the workbook’s Sauce 2 column.</small></label>}
        {c.type === 'Extra sauce / topping' && <label className="av2-field">Served with component<select aria-label="Served with component" value={c.attachedComponentId || ''} onChange={e => componentField(c.id, 'attachedComponentId', e.target.value)}><option value="">Choose component...</option>{form.components.filter(item => ['Protein', 'Breakfast', 'Snack', 'Carb', 'Vegetable'].includes(item.type)).map(item => <option key={item.id} value={item.id}>{componentLabel(item.type)} · {item.name || 'Unnamed component'}</option>)}</select><small>Link this extra to its main item, carb, salad or vegetables.</small></label>}
        <div className="av2-rule-grid"><label>Adaptation rule<select value={c.adaptation} onChange={e => componentField(c.id, 'adaptation', e.target.value)}>{ADAPTATIONS.map(v => <option key={v}>{v}</option>)}</select></label><label>Serving relationship<select value={c.relationship} onChange={e => componentField(c.id, 'relationship', e.target.value)}>{RELATIONSHIPS.map(v => <option key={v}>{v}</option>)}</select></label></div>
        {['Can substitute', 'Alternative preparation'].includes(c.adaptation) && <label className="av2-field">Alternative / kitchen instruction<input value={c.replacement} onChange={e => componentField(c.id, 'replacement', e.target.value)} placeholder="Describe the approved alternative"/></label>}
        {c.originalText && <details className="av2-source-detail"><summary>Original component text · source {c.sourceCell || 'workbook'}</summary><p>{c.originalText}</p></details>}
      </Panel>; };
  return <>
    <Link className="av2-back" to={`${BASE}/meals`}><ArrowLeft size={15}/>Back to meal cycle</Link>
    <PageHeading title={isNew ? 'Create Meal' : 'Edit Meal'} subtitle={`${form.id} · April Cycle 1 · workbook-based preview`}><Link className="av2-action" to={`${BASE}/meals`}>Cancel</Link><Action primary icon={Save} onClick={save}>Save preview draft</Action></PageHeading>
    {error && <div role="alert"><Notice tone="red">{error}</Notice></div>}
    <div className="av2-composer-layout"><div>
      <Panel title="Meal details"><p>Meal information and types from your workbook.</p><div className="av2-form-grid"><label>Meal ID<input readOnly value={form.id}/></label><label>Meal format<select aria-label="Meal format" value={form.mealFormat} onChange={e => field('mealFormat', e.target.value)}>{MEAL_FORMATS.map(format => <option key={format}>{format}</option>)}</select></label><label>Meal type{form.mealFormat !== 'Main' && <small>Optional for breakfast and snacks</small>}<select aria-label="Meal type" value={form.mealType} onChange={e => field('mealType', e.target.value)}><option value="">Choose meal type...</option>{MEAL_TYPES.map(type => <option key={type}>{type}</option>)}</select></label><label>Temperature<select value={form.temperature} onChange={e => field('temperature', e.target.value)}><option>WARM</option><option>COLD</option></select></label></div><label className="av2-field">Meal name<input value={form.name} onChange={e => field('name', e.target.value)}/></label><div className="av2-form-grid"><label>Tags<input value={form.tags} placeholder="e.g. SALAD BASE, VEG INSIDE EGG" onChange={e => field('tags', e.target.value)}/></label><label>Carb combined with veg<select value={form.carbCombined} onChange={e => field('carbCombined', e.target.value)}><option>No</option><option>Yes</option><option>Not specified</option></select></label></div><label className="av2-field">Meal preparation / option notes<textarea rows={3} value={form.notes} onChange={e => field('notes', e.target.value)} placeholder="Keep the chef’s meal-level instructions here"/></label></Panel>
      <div className="av2-heading"><div><h2>Meal components</h2><p>Each component has its own exclusions and kitchen instructions.</p></div><Action icon={Plus} onClick={() => setAdding(true)}>Add component</Action></div>
      {!form.components.length && <Panel><p>No components yet. Add a main item, breakfast or snack to begin.</p></Panel>}
      {[
        ['Main item & carb', form.components.filter(c => !['Vegetable', 'Sauce 2', 'Sauce', 'Extra sauce / topping', 'Garnish'].includes(c.type))],
        ['Salad / vegetables & dressing', form.components.filter(c => ['Vegetable', 'Sauce 2'].includes(c.type)).sort((a, b) => (a.type === 'Vegetable' ? 0 : 1) - (b.type === 'Vegetable' ? 0 : 1))],
        ['Extra sauces & toppings', form.components.filter(c => c.type === 'Extra sauce / topping')],
        ['Meal sauce & garnish', form.components.filter(c => ['Sauce', 'Garnish'].includes(c.type))],
      ].filter(([, components]) => components.length).map(([heading, components]) => <section className="av2-component-section" key={heading} aria-label={heading}><h3>{heading}</h3>{components.map(renderComponent)}</section>)}
    </div><aside className="av2-meal-summary"><Panel title="Meal at a glance"><div className="av2-badges"><Badge tone="lime">{form.mealFormat}</Badge>{form.mealType && <Badge tone="outline">{form.mealType}</Badge>}</div><h3>{form.name || 'Untitled meal'}</h3><small>{form.temperature}</small><dl>{form.components.map(c => <div key={c.id}><dt>{componentLabel(c.type)}</dt><dd>{c.name || 'Not named'}{c.type === 'Extra sauce / topping' && <small>With: {form.components.find(target => target.id === c.attachedComponentId)?.name || 'Choose component'}</small>}</dd></div>)}</dl></Panel><Panel title="Dietary flags across all components"><Chips values={flags.filter(Boolean)} tone="amber"/><p>Includes the meal sauce, salad dressing, extras and garnish. No recorded flag does not mean allergen-free.</p></Panel><Notice tone="amber"><strong>Kitchen review needed</strong><p>Adaptations start as Not reviewed. Confirm the original notes with the kitchen before approving an alternative.</p></Notice><Panel title="Source"><small>Meals row {form.workbookRow || 'New preview meal'}</small><small>Original source rows: {form.sourceRows || '—'}</small><p>Local preview only. Supy recipe IDs, quantities and nutritional values have not been imported.</p></Panel></aside></div>
    {adding && <Modal title="Add meal component" onClose={() => setAdding(false)} footer={<Action onClick={() => setAdding(false)}>Cancel</Action>}><p>Choose a slot. Add a meal sauce, salad dressing, extra sauce / topping or another component.</p><div className="av2-choice-chips">{COMPONENT_TYPES.map(type => <button key={type} onClick={() => { field('components', [...form.components, { id: `component-${Date.now()}-${form.components.length}`, type, name: '', exclusions: [], notes: '', adaptation: 'Not reviewed', relationship: 'Not reviewed', replacement: '', attachedComponentId: '' }]); setAdding(false); }}>{componentLabel(type)}</button>)}</div></Modal>}
  </>;
}

export function CyclePlanner({ meals, source, onImport }) { return <WeeklyCycleBoard meals={meals} source={source} onImport={onImport} importDialog={(onClose, handleImport) => <WorkbookImport onClose={onClose} onImport={handleImport}/>}/>; }
