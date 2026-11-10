import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, ArrowLeft, Upload, FileSpreadsheet, X, Save } from 'lucide-react';
import { Action, Badge, Panel, SearchBox, Select, Notice, DataTable, Modal } from './components';
import { CYCLE_DAYS, MEAL_TYPES, mealType, mealFormat, dietaryFlags, componentName, parseMealWorkbook } from './workbookMeals';

import WeeklyCycleBoard from './WeeklyCycleBoard';
import ComponentExclusions from './ComponentExclusions';
import { editorComponents } from './mealEditorState';

const BASE = '/admin/meal-selection-v2';
const componentLabel = type => type === 'Sauce 2' ? 'Salad dressing (optional)' : type;
const ADAPTATIONS = ['Not reviewed', 'Dairy-free option available.', 'Gluten-free option available.', 'Dairy- and gluten-free option available.', 'Nut-free option available.', 'No dairy-free option.', 'No gluten-free option.', 'No nut-free option.', 'No dairy- and gluten-free option.', 'No dairy- and nut-free option.', 'No gluten- and nut-free option.', 'No dairy-, gluten- and nut-free option.'];
const kindOf = meal => mealFormat(meal) === 'Main' ? 'Main meal' : mealFormat(meal);
const newComponent = type => ({ id: `component-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type, name: '', exclusions: [], notes: '', adaptation: 'Not reviewed' });
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
    <p>Use the workbook layout: Meals and Components sheets, linked by Meal ID. Both sauces, categories, exclusions and preparation notes are preserved.</p>
    <label className="av2-upload"><Upload size={20}/><span>Choose workbook<input aria-label="Choose meal cycle workbook" type="file" accept=".xlsx,.xls" onChange={read}/></span></label>
    {loading && <p role="status">Reading both sheets…</p>}
    {error && <div role="alert"><Notice tone="red">{error}</Notice></div>}
    {result && <><Notice tone="green"><strong>{result.meals.length} meals · {result.meals.reduce((sum, m) => sum + m.components.length, 0)} components</strong><p>Matched by Meal ID. This replaces only your local preview cycle.</p></Notice><DataTable headers={['Meal ID', 'Day', 'Meal type', 'Meal name', 'Components']} rows={result.meals.slice(0, 6).map(m => [m.id, m.day, mealType(m) || 'Not selected', m.name, m.components.length])}/><small>Showing the first six meals. All imported meals remain drafts; Supy links and dietary rules need review.</small></>}
  </Modal>;
}

export function MealLibrary({ meals, source, onImport }) {
  const [query, setQuery] = useState(''), [day, setDay] = useState(''), [category, setCategory] = useState(''), [temperature, setTemperature] = useState('');
  const [importing, setImporting] = useState(false);
  const filtered = meals.filter(m => (!day || m.day === day) && (!category || mealType(m) === category) && (!temperature || m.temperature === temperature) && [m.id, m.name, ...m.components.map(c => c.name)].some(value => value.toLowerCase().includes(query.toLowerCase())));
  const stats = [[meals.length, 'Meals in cycle'], [meals.reduce((s, m) => s + m.components.length, 0), 'Component entries'], [meals.filter(m => m.components.some(c => c.type === 'Sauce 2')).length, 'Meals with salad dressing'], [new Set(meals.map(m => m.day).filter(Boolean)).size, 'Cycle day groups']];
  return <>
    <PageHeading title="Meals" subtitle="Create meals and assign them in your cycle menu."><Action icon={Upload} onClick={() => setImporting(true)}>Import Excel cycle</Action><Link to={`${BASE}/meals/new`} className="av2-action av2-primary"><Plus size={15}/>Create meal</Link></PageHeading>
    <div className="av2-source-strip"><FileSpreadsheet size={18}/><div><strong>{source || 'No workbook imported'}</strong><small>Workbook preview · local edits only · Supy recipe links not verified</small></div></div>
    <div className="av2-stats av2-workbook-stats">{stats.map(([value, label]) => <Panel key={label}><h2>{value}</h2><small>{label}</small></Panel>)}</div>
    {!meals.length && <Panel title="No meals yet"><p>Create your first meal or import your workbook to get started.</p></Panel>}<div className="av2-section-bar"><Link className="av2-text-button" to={`${BASE}/weekly-menu`}>View cycle planner →</Link></div>
    <div className="av2-filters"><SearchBox placeholder="Search meal, component or ID..." value={query} onChange={setQuery}/><Select label="All cycle days" values={CYCLE_DAYS} value={day} onChange={setDay}/><Select label="All meal types" values={MEAL_TYPES} value={category} onChange={setCategory}/><Select label="All temperatures" values={['WARM', 'COLD']} value={temperature} onChange={setTemperature}/></div>
    <div className="av2-workbook-table"><DataTable headers={['Meal ID / Day', 'Meal type', 'Item kind', 'Temperature', 'Meal name', 'Protein / main item', 'Carb', 'Vegetable', 'Meal sauce', 'Salad dressing', 'Extra sauce / topping', 'Garnish', 'Tags / Combined', 'Preparation / option notes', 'Edit']} rows={filtered.map(m => [<><Link to={`${BASE}/meals/${m.id}`} className="av2-meal-id">{m.id}</Link><small>{m.day}</small></>, <Badge tone="outline">{mealType(m) || 'Not selected'}</Badge>, <Badge tone="lime">{kindOf(m)}</Badge>, <Badge tone={m.temperature === 'COLD' ? 'blue' : 'amber'}>{m.temperature}</Badge>, <strong>{m.name}</strong>, ...['Main item', 'Carb', 'Vegetable', 'Sauce', 'Sauce 2', 'Extra sauce / topping', 'Garnish'].map(t => componentName(m, t)), <>{m.tags && <Badge tone="lime">{m.tags}</Badge>}<small>Carb + veg: {m.carbCombined || 'Not specified'}</small></>, m.notes || <small>No meal-level notes</small>, <Link className="av2-icon" aria-label={`Edit ${m.id}`} to={`${BASE}/meals/${m.id}`}><Pencil size={16}/></Link>])}/></div>
    <p className="av2-table-hint">{filtered.length} of {meals.length} meals · Scroll the table horizontally to see all workbook columns.</p>
    {importing && <WorkbookImport onClose={() => setImporting(false)} onImport={onImport}/>}
  </>;
}

export function ComponentLibrary({ meals }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const entries = meals.flatMap(meal => meal.components.map(component => ({ meal, component })));
  const filtered = entries.filter(({ meal, component }) => (!type || component.type === type) && [meal.name, meal.id, component.name, component.type, ...(component.exclusions || [])].some(value => String(value || '').toLowerCase().includes(query.toLowerCase())));
  return <>
    <PageHeading title="Components" subtitle="Meal components, exclusions and preparation notes." />
    <Panel>
      <div className="av2-filters"><SearchBox placeholder="Search components..." value={query} onChange={setQuery}/><Select label="All component types" values={[...new Set(entries.map(({ component }) => component.type))]} value={type} onChange={setType}/></div>
      <DataTable headers={['Component name', 'Component type', 'Used in meal', 'Exclusions / dietary flags', 'Adaptation rule', 'Preparation / option notes', 'Edit']} empty="No components yet. Create a meal or import your workbook to get started." rows={filtered.map(({ meal, component: c }) => [<strong>{c.name}</strong>, <Badge tone="outline">{componentLabel(c.type)}</Badge>, <Link to={`${BASE}/meals/${meal.id}`}>{meal.name}</Link>, <Chips values={c.exclusions || []} tone="amber"/>, c.adaptation || 'Not reviewed', c.notes || '—', <Link className="av2-icon" aria-label={`Edit ${c.name}`} to={`${BASE}/meals/${meal.id}`}><Pencil size={16}/></Link>])}/>
      <p className="av2-table-hint">{filtered.length} of {entries.length} components</p>
    </Panel>
  </>;
}

export function MealComposer({ meal, isNew, onSave }) {
  const [form, setForm] = useState(() => {
    const initial = meal ? JSON.parse(JSON.stringify(meal)) : { id: `PREVIEW-${Date.now()}`, name: '', day: '', category: '', temperature: 'WARM', tags: '', carbCombined: 'No', notes: '', components: [] };
    const mealKind = meal ? kindOf(meal) : 'Main meal';
    const isSaladBase = mealKind === 'Main meal' && (meal?.isSaladBase ?? Boolean(initial.components.some(c => c.type === 'Sauce 2' || c.type === 'Salad') || /SALAD BASE/i.test(initial.tags || '')));
    return { ...initial, mealKind, mealType: meal ? mealType(meal) : '', isOatmeal: meal?.isOatmeal ?? meal?.category === 'OATS', isSaladBase, components: editorComponents(initial, mealKind, isSaladBase) };
  });
  const kindDrafts = useRef({});
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  if (!meal && !isNew) return <Notice>Meal not found. <Link to={`${BASE}/meals`}>Return to meals</Link></Notice>;
  const field = (key, value) => { setError(''); setForm(f => ({ ...f, [key]: value })); };
  const componentField = (id, key, value) => setForm(f => ({ ...f, components: f.components.map(c => c.id === id ? { ...c, [key]: value } : c) }));
  const isSnack = form.mealKind === 'Snack', isBreakfast = form.mealKind === 'Breakfast';
  const allowed = ['Protein', 'Carb', 'Vegetable', 'Sauce', 'Garnish'].filter(type => type !== 'Vegetable' || isBreakfast || !form.isSaladBase);
  // Existing extras remain editable for both main meals and breakfasts.
  const editableComponents = form.components.filter(c => allowed.includes(c.type) || c.type === 'Extra sauce / topping');
  const salad = form.components.find(c => c.type === 'Salad');
  const dressing = form.components.find(c => c.type === 'Sauce 2');
  const snack = form.components.find(c => c.type === 'Snack');
  const changeKind = kind => {
    if (kind === form.mealKind) return;
    setError(''); setAdding(false);
    // Keep complete immutable drafts, including notes, exclusions and removals.
    kindDrafts.current[form.mealKind] = form;
    if (kindDrafts.current[kind]) {
      setForm(kindDrafts.current[kind]);
      return;
    }
    const isSaladBase = kind === 'Main meal' && form.isSaladBase;
    const types = kind === 'Breakfast' ? ['Protein', 'Carb', 'Vegetable', 'Sauce', 'Garnish', 'Extra sauce / topping'] : ['Protein', 'Carb', 'Vegetable', 'Sauce', 'Garnish', 'Salad', 'Sauce 2', 'Extra sauce / topping'];
    const components = editorComponents(form, kind, isSaladBase);
    setForm({ ...form, mealKind: kind, isSaladBase, components: kind === 'Snack' ? components : components.filter(c => types.includes(c.type)) });
  };
  const toggleSalad = checked => setForm(f => {
    if (!checked) return { ...f, isSaladBase: false, components: f.components.filter(c => c.type !== 'Sauce 2').map(c => c.type === 'Salad' ? { ...c, type: 'Vegetable' } : c) };
    const vegetables = f.components.filter(c => ['Vegetable', 'Salad'].includes(c.type));
    const saladComponent = vegetables.length ? { ...vegetables[0], type: 'Salad', name: vegetables.map(c => c.name).filter(Boolean).join(' + '), exclusions: [...new Set(vegetables.flatMap(c => c.exclusions || []))], notes: vegetables.map(c => c.notes).filter(Boolean).join('\n') } : newComponent('Salad');
    return { ...f, isSaladBase: true, components: [...f.components.filter(c => !['Vegetable', 'Salad'].includes(c.type)), saladComponent, ...(!f.components.some(c => c.type === 'Sauce 2') ? [newComponent('Sauce 2')] : [])] };
  });
  const save = () => {
    if (!form.name.trim()) return setError(`Enter a ${isSnack ? 'snack' : 'meal'} name.`);
    if (form.mealKind === 'Main meal' && form.isSaladBase && !salad?.name.trim()) return setError('Enter the salad name or uncheck Includes a salad base.');
    if (form.mealKind === 'Main meal' && !MEAL_TYPES.includes(form.mealType)) return setError('Choose Chicken, Beef or Fish for a main meal.');
    let components = isSnack ? [{ ...(snack || newComponent('Snack')), name: form.name.trim() }] : form.components.filter(c => allowed.includes(c.type) || c.type === 'Extra sauce / topping' || (form.isSaladBase && ['Salad', 'Sauce 2'].includes(c.type)));
    components = components.filter(c => c.type !== 'Sauce 2' || c.name.trim());
    if (!components.length || components.some(c => !c.name.trim())) return setError('Add a name for each component, including the salad when selected.');
    onSave({ ...form, name: form.name.trim(), mealFormat: isBreakfast ? 'Breakfast' : isSnack ? 'Snack' : 'Main', mealType: form.mealKind === 'Main meal' ? form.mealType : '', isOatmeal: isBreakfast && form.isOatmeal, isSaladBase: form.mealKind === 'Main meal' && form.isSaladBase, status: 'Draft', components: components.map(({ relationship, ...c }) => c.type === 'Sauce 2' ? { ...c, saladComponentId: salad?.id || '' } : c) });
  };
  const renderComponent = c => <Panel className="av2-component-panel" key={c.id} title={componentLabel(c.type)} actions={<button className="av2-icon" aria-label={`Remove ${c.type} component`} onClick={() => field('components', form.components.filter(v => v.id !== c.id))}><X size={16}/></button>}>
    <label className="av2-field">Component / recipe name<input value={c.name} onChange={e => componentField(c.id, 'name', e.target.value)}/></label>
    <ComponentExclusions values={c.exclusions || []} componentName={c.name || c.type} onChange={values => componentField(c.id, 'exclusions', values)}/>
    <label className="av2-field">Adaptation rule<select aria-label="Adaptation rule" value={ADAPTATIONS.includes(c.adaptation) ? c.adaptation : 'Not reviewed'} onChange={e => componentField(c.id, 'adaptation', e.target.value)}>{ADAPTATIONS.map(v => <option key={v}>{v}</option>)}</select></label>
    <label className="av2-field">Preparation / option notes<textarea value={c.notes || ''} rows={2} onChange={e => componentField(c.id, 'notes', e.target.value)}/></label>
  </Panel>;
  return <>
    <Link className="av2-back" to={`${BASE}/meals`}><ArrowLeft size={15}/>Back to meals</Link>
    <PageHeading title={isNew ? 'Create Meal' : 'Edit Meal'} subtitle="Main and Sub are assigned when you place a meal in the cycle menu."><Link className="av2-action" to={`${BASE}/meals`}>Cancel</Link><Action primary icon={Save} onClick={save}>Save preview draft</Action></PageHeading>
    {error && <div role="alert"><Notice tone="red">{error}</Notice></div>}
    <Panel title="Create as"><fieldset className="av2-choice-chips"><legend>Choose what to create</legend>{['Main meal', 'Breakfast', 'Snack'].map(kind => <label key={kind}><input type="radio" name="meal-kind" checked={form.mealKind === kind} onChange={() => changeKind(kind)}/>{kind}</label>)}</fieldset></Panel>
    <Panel title={isSnack ? 'Snack details' : 'Meal details'}>
      <label className="av2-field">{isSnack ? 'Snack name' : 'Meal name'}<input value={form.name} onChange={e => field('name', e.target.value)}/></label>
      {isSnack ? <ComponentExclusions values={snack?.exclusions || []} componentName={form.name || 'snack'} onChange={values => field('components', [{ ...(snack || newComponent('Snack')), name: form.name, exclusions: values }])}/> : <>
        <div className="av2-form-grid">{!isBreakfast && <label>Meal type<select aria-label="Meal type" value={form.mealType} onChange={e => field('mealType', e.target.value)}><option value="">Choose meal type...</option>{MEAL_TYPES.map(type => <option key={type}>{type}</option>)}</select></label>}<label>Temperature<select aria-label="Temperature" value={form.temperature} onChange={e => field('temperature', e.target.value)}><option>WARM</option><option>COLD</option></select></label></div>
        {isBreakfast && <label className="av2-field"><span><input type="checkbox" checked={form.isOatmeal} onChange={e => field('isOatmeal', e.target.checked)}/>Oatmeal</span></label>}
        {!isBreakfast && <label className="av2-field"><span><input type="checkbox" checked={form.isSaladBase} onChange={e => toggleSalad(e.target.checked)}/>Includes a salad base</span></label>}
      </>}
    </Panel>
    {!isSnack && <>
      {!isBreakfast && form.isSaladBase && <Panel title="Salad base"><p>The salad is the vegetable component for this meal.</p>
        <label className="av2-field">Salad name<input value={salad?.name || ''} onChange={e => salad ? componentField(salad.id, 'name', e.target.value) : field('components', [...form.components, { ...newComponent('Salad'), name: e.target.value }])}/></label>
        <ComponentExclusions values={salad?.exclusions || []} componentName={salad?.name || 'salad'} onChange={values => salad ? componentField(salad.id, 'exclusions', values) : field('components', [...form.components, { ...newComponent('Salad'), exclusions: values }])}/>
        <label className="av2-field">Salad sauce (optional extra sauce)<input value={dressing?.name || ''} onChange={e => dressing ? componentField(dressing.id, 'name', e.target.value) : field('components', [...form.components, { ...newComponent('Sauce 2'), name: e.target.value }])}/></label>
        <ComponentExclusions values={dressing?.exclusions || []} componentName={dressing?.name || 'salad sauce'} onChange={values => dressing ? componentField(dressing.id, 'exclusions', values) : field('components', [...form.components, { ...newComponent('Sauce 2'), exclusions: values }])}/>
      </Panel>}
      <div className="av2-heading"><div><h2>{isBreakfast ? 'Breakfast components' : 'Meal components'}</h2><p>{isBreakfast ? 'Add protein, carb, vegetables, sauce and garnish.' : 'Add the meal components. A salad base replaces the vegetable component; its sauce is optional.'}</p></div><Action icon={Plus} onClick={() => setAdding(true)}>Add component</Action></div>
      {editableComponents.map(renderComponent)}
      {adding && <Modal title="Add meal component" onClose={() => setAdding(false)} footer={<Action onClick={() => setAdding(false)}>Cancel</Action>}><div className="av2-choice-chips">{allowed.map(type => <button key={type} onClick={() => { field('components', [...form.components, newComponent(type)]); setAdding(false); }}>{type}</button>)}</div></Modal>}
      <Panel title="Dietary flags across all components"><Chips values={dietaryFlags(form).filter(Boolean)} tone="amber"/></Panel>
    </>}
  </>;
}

export function CyclePlanner({ meals, source, onImport }) { return <WeeklyCycleBoard meals={meals} source={source} onImport={onImport} importDialog={(onClose, handleImport) => <WorkbookImport onClose={onClose} onImport={handleImport}/>}/>; }
