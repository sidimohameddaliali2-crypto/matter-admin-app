import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Calendar, ArrowLeft, Eye, Pencil, RefreshCw, Download, Lock, X, SlidersHorizontal } from 'lucide-react';
import { ingredients as initialIngredients, recipes, meals as initialMeals, kitchenRows, counts } from './data';
import aprilCycle from './aprilCycle.json';
import { parseMealWorkbook } from './workbookMeals';
import { MealLibrary, MealComposer, CyclePlanner } from './WorkbookMealPages';
import { Action, Badge, Allergens, Panel, Tabs, SearchBox, Select, Notice, DataTable, Modal, downloadCsv } from './components';
import '../../styles/matterChrome.css';
import './adminMealSelectionV2.css';
const BASE = '/admin/meal-selection-v2';
const INITIAL_CYCLE = { meals: parseMealWorkbook(aprilCycle.sheets), source: aprilCycle.source };
const PAGES = ['ingredients', 'recipes', 'meals', 'weekly-menu', 'kitchen', 'subscriptions'];
const status = s => <Badge tone={s === 'Published' ? 'green' : 'grey'}>{s}</Badge>;
const matches = (value, query) => String(value || '').toLowerCase().includes(query.toLowerCase());
const titleCell = (name, sub) => <><strong>{name}</strong>{sub && <small>{sub}</small>}</>;
function usePreviewState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`matter-admin-v2:${key}`));
      return saved ?? initial;
    } catch {
      return initial;
    }
  });
  const update = next => setValue(previous => {
    const result = typeof next === 'function' ? next(previous) : next;
    try {
      sessionStorage.setItem(`matter-admin-v2:${key}`, JSON.stringify(result));
    } catch {/* In-memory preview works when storage is unavailable. */}
    return result;
  });
  return [value, update];
}
export default function AdminMealSelectionV2() {
  const location = useLocation(),
    navigate = useNavigate();
  const contentRef = useRef(null);
  useEffect(() => { contentRef.current?.closest('main')?.scrollTo(0, 0); }, [location.pathname]);
  const [ingredients, setIngredients] = usePreviewState('ingredients', initialIngredients);
  const [cycle, setCycle] = usePreviewState('workbook-cycle-v1', INITIAL_CYCLE);
  const [message, setMessage] = useState('');
  const route = location.pathname.slice(BASE.length).split('/').filter(Boolean);
  const page = route[0] || 'meals';
  if (!PAGES.includes(page)) return <Navigate to={`${BASE}/meals`} replace />;
  const explainSync = () => setMessage('This is a design preview. Supy sync is available on the existing live pages; no live data has been changed.');
  return <div className="av2 av2-integrated" ref={contentRef}>
    <div className="av2-page-body">{message && <div className="av2-feedback" role="status">{message}<button aria-label="Dismiss message" onClick={() => setMessage('')}><X size={16} /></button></div>}
        {page === 'ingredients' && <Ingredients items={ingredients} onSave={item => setIngredients(items => items.map(i => i.id === item.id ? item : i))} onSync={explainSync} />}
        {page === 'recipes' && (route[1] ? <RecipeDetail recipe={recipes.find(r => r.id === route[1])} /> : <Recipes onSync={explainSync} />)}
        {page === 'meals' && (route[1] ? <MealComposer key={route[1]} meal={cycle.meals.find(m => m.id === route[1])} isNew={route[1] === 'new'} onSave={meal => {
          setCycle(current => ({ ...current, meals: current.meals.some(m => m.id === meal.id) ? current.meals.map(m => m.id === meal.id ? meal : m) : [...current.meals, meal] }));
          setMessage('Meal and component rules saved in this preview session.');
          navigate(`${BASE}/meals`);
        }} /> : <MealLibrary meals={cycle.meals} source={cycle.source} onImport={setCycle} />)}
        {page === 'weekly-menu' && <CyclePlanner meals={cycle.meals} source={cycle.source} onImport={setCycle} />}
        {page === 'kitchen' && <Kitchen />}
        {page === 'subscriptions' && <Subscription meals={initialMeals} />}
    </div>
  </div>;
}
function Heading({
  title,
  subtitle,
  children
}) {
  return <div className="av2-page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="av2-actions">{children}</div></div>;
}
function Ingredients({
  items,
  onSave,
  onSync
}) {
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [allergen, setAllergen] = useState(''),
    [exclusion, setExclusion] = useState(''),
    [tab, setTab] = useState('Used in meals'),
    [edit, setEdit] = useState(null);
  const filtered = items.filter(i => matches(i.name, query) && (!category || i.category === category) && (!allergen || (allergen === 'Not set' ? i.allergens === null : i.allergens?.includes(allergen))) && (!exclusion || i.exclusion === exclusion) && (tab !== 'Name changed' || i.display) && (tab !== 'Used in meals' || i.used));
  return <><Heading title="Ingredients Management" subtitle="Supy items from the Matter kitchen location. Read-only: only the name customers see can be changed."><Action icon={RefreshCw} onClick={onSync}>Sync from Supy</Action></Heading>
    <Notice tone="amber"><strong>12 recipes used in active meals have no allergens set in Supy</strong><p>A meal cannot be published until your team sets them in Supy or confirms a recipe has none.</p><Link to={`${BASE}/recipes`}>Open recipes →</Link></Notice>
    <Tabs values={['All items', 'Used in meals', 'Name changed']} value={tab} onChange={setTab} />
    <div className="av2-filters"><SearchBox placeholder="Search ingredients..." value={query} onChange={setQuery} /><Select label="All categories" values={[...new Set(items.map(i => i.category))]} value={category} onChange={setCategory} /><Select label="All allergens" values={['Dairy', 'Soy', 'Gluten', 'Not set']} value={allergen} onChange={setAllergen} /><Select label="All exclusions" values={['Mushroom', 'Coriander']} value={exclusion} onChange={setExclusion} /></div>
    <DataTable headers={['Ingredient name', 'Category › Sub-category', 'Cost per gram', 'Allergens (Supy)', 'On exclusions list', 'Details']} rows={filtered.map(i => [titleCell(i.name, `Used in ${i.used} recipes`), titleCell(i.category, `› ${i.sub}`), `AED ${i.cost}`, <Allergens values={i.allergens} />, i.exclusion ? <Badge>{i.exclusion}</Badge> : <span className="av2-muted">None</span>, <button className="av2-icon" aria-label={`View ${i.name}`} onClick={() => setEdit({
      ...i
    })}><Eye size={16} /></button>])} />
    {edit && <Modal title="Ingredient Details" onClose={() => setEdit(null)} footer={<><Action onClick={() => setEdit(null)}>Cancel</Action><Action primary onClick={() => {
        onSave(edit);
        setEdit(null);
      }}>Save name</Action></>}><Badge tone="green">From Supy</Badge><div className="av2-form-grid"><label>Name in Supy (read-only)<input value={edit.name} readOnly /></label><label>Category (from Supy)<input value={`${edit.category} › ${edit.sub}`} readOnly /></label><label>Name customers see (optional)<input value={edit.display || ''} onChange={e => setEdit({
            ...edit,
            display: e.target.value
          })} /></label></div><Panel title="Allergens (from Supy)"><p>Read-only. Allergens are tagged in Supy and read on every sync. To change them, edit them in Supy.</p><Allergens values={edit.allergens} /></Panel><Panel title="On the exclusions list as"><p>Customers who exclude this ingredient get a warning on meals using it.</p><Badge tone="navy">{edit.exclusion || 'Not linked'}</Badge></Panel></Modal>}
  </>;
}
function Recipes({
  onSync
}) {
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [protein, setProtein] = useState(''),
    [allergen, setAllergen] = useState(''),
    [categories, setCategories] = useState(false);
  const filtered = recipes.filter(r => matches(r.name, query) && (!category || r.category === category) && (!protein || r.protein === protein) && (!allergen || (allergen === 'Not set' ? r.allergens === null : r.allergens?.includes(allergen))));
  return <><Heading title="Recipe Management" subtitle="Recipes come from Supy. We keep Matter’s categories and work allergens out from their ingredients."><Action icon={SlidersHorizontal} onClick={() => setCategories(true)}>Categories</Action><Action primary icon={RefreshCw} onClick={onSync}>Sync from Supy</Action></Heading>
    <Notice><strong>Last sync: 27 Oct, 8:57 PM · sample data</strong><p>Recipes cannot be created or edited here; change them in Supy.</p></Notice>
    <div className="av2-filters"><SearchBox placeholder="Search recipes..." value={query} onChange={setQuery} /><Select label="All categories" values={['Protein', 'Carb', 'Sauce', 'Breakfast']} value={category} onChange={setCategory} /><Select label="All proteins" values={['Chicken', 'Beef']} value={protein} onChange={setProtein} /><Select label="Allergens: all" values={['Gluten', 'Soy', 'Egg', 'Dairy', 'Not set']} value={allergen} onChange={setAllergen} /></div>
    <Panel title="Recipes"><DataTable headers={['Recipe name', 'Category', 'Yield %', 'Ingredients', 'Nutritional info (per 100g)', 'Allergens', 'Status', 'Details']} rows={filtered.map(r => [titleCell(r.name, `${r.protein ? `${r.protein} · ` : ''}Supy ${r.code}`), <Badge tone="outline">{r.category}</Badge>, r.yield, r.count, r.nutrition || <span className="av2-muted">Not set (decision 2)</span>, <Allergens values={r.allergens} />, status(r.status), <Link className="av2-icon" aria-label={`View ${r.name}`} to={`${BASE}/recipes/${r.id}`}><Eye size={16} /></Link>])} /></Panel>
    {categories && <Modal title="Recipe categories" onClose={() => setCategories(false)} footer={<Action onClick={() => setCategories(false)}>Close</Action>}><p>Categories available in the preview recipe library.</p><div className="av2-badges">{['Protein', 'Carb', 'Vegetable', 'Sauce', 'Breakfast', 'Snack'].map(c => <Badge tone="outline" key={c}>{c}</Badge>)}</div></Modal>}
  </>;
}
function RecipeDetail({
  recipe
}) {
  if (!recipe) return <Notice>Recipe not found. <Link to={`${BASE}/recipes`}>Return to recipes</Link></Notice>;
  return <><Link className="av2-back" to={`${BASE}/recipes`}><ArrowLeft size={16} />Back to recipes</Link><Heading title={recipe.name} subtitle="Recipe from Supy · read-only preview" />
    <div className="av2-columns"><Panel title="Recipe Information"><dl>{Object.entries({
            Category: recipe.category,
            'Protein type': recipe.protein || '—',
            'Supy type': 'Semi-finished',
            'Yield percentage': recipe.yield,
            'Supy code': recipe.code,
            'Last synced': '27 Oct 2026, 8:57 PM'
          }).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></Panel><Panel title="Allergens (from Supy)"><p>Read from this recipe in Supy. To change them, edit the recipe in Supy.</p><Allergens values={recipe.allergens} /><small>Last read from Supy 27 Oct 2026, 8:57 PM</small></Panel></div>
    <Panel title="Ingredients"><p>Sample ingredient breakdown for design review.</p><DataTable headers={['Ingredient', 'Quantity', 'Unit', 'Prep wastage', 'Allergens']} rows={recipe.id === 'sweet' ? [['Chicken Breast Frozen', 1, 'Kg', '0%', 'None'], ['Sunflower Oil', 50, 'mL', '0%', 'None'], ['Pepper Black Powder', 2, 'g', '0%', 'None'], ['Sweet and Sour Sauce', 1.8, 'Piece', '0%', <Allergens values={['Gluten', 'Soy']} />]] : []} empty="Ingredient breakdown is not included in this sample recipe." /></Panel>
    <Panel title="Used in meals"><Link to={`${BASE}/meals`}><Badge tone="lime">Browse meals using the recipe library</Badge></Link></Panel><Panel title="Version history"><p>A new version is saved whenever a Supy sync changes allergens, ingredients, quantities or yield.</p>{['v3 · Current · 27 Oct 2026, 8:57 PM', 'v2 · 12 Oct 2026, 9:02 PM', 'v1 · 1 Jun 2024 · First sync'].map(v => <div className="av2-history-row" key={v}><strong>{v}</strong><span>Sample Supy sync version</span></div>)}</Panel>
  </>;
}
function Kitchen() {
  const [tab, setTab] = useState('Kitchen List'),
    [query, setQuery] = useState(''),
    [plan, setPlan] = useState(''),
    [flag, setFlag] = useState(''),
    [locked, setLocked] = usePreviewState('kitchen-locked', false);
  const headers = ['Customer', 'Plan', 'Item', 'Protein', 'Carb', 'Veg', 'C / P / F', 'kcal', 'Flags'];
  const filtered = kitchenRows.filter(r => matches(r[0], query) && (!plan || r[1] === plan) && (!flag || r[8] === flag));
  return <><Heading title="Kitchen Dashboard" subtitle="Daily kitchen list, counting and dietary breakdown"><span className="av2-date"><Calendar size={14} />Tue 3 Nov 2026</span><Action icon={Download} onClick={() => downloadCsv('kitchen-preview.csv', headers, filtered)}>Export CSV</Action><Action primary icon={Lock} onClick={() => setLocked(v => !v)}>{locked ? 'Locked · unlock preview' : 'Lock & snapshot'}</Action></Heading>
    <Tabs values={['Kitchen List', 'Counting', 'Overview', 'Cook Plan']} value={tab} onChange={setTab} />
    {locked ? <Notice tone="green"><strong>Locked · preview snapshot</strong><p>The sample totals are fixed for review. No production kitchen has been locked.</p><small>Versions used: menu v3 · formula 1.0 · portion tables v4 · 61 meal versions</small></Notice> : <Notice><strong>Open — Tuesday picks close Sat 31 Oct, 5:00 PM · kitchen locks at 7:00 PM (Dubai time)</strong><p>Between the two, CS can still fix picks. Lock saves a snapshot; counting and exports read only the snapshot.</p></Notice>}
    {tab === 'Kitchen List' && <><Notice tone="amber"><strong>3 picks changed after the menu was published</strong><p>Bo Kho Beef’s recipe gained peanuts in Supy (menu v3). Two customers picked again; one gets a chef pick at the deadline.</p></Notice><div className="av2-stats">{[['Customers', '312', 'Delivering on Tue 3 Nov'], ['Meals', '845', 'Mains and breakfasts'], ['Picked by customer', '71%', '29% chosen by chef'], ['Needs attention', '4', 'No safe meal, or a clash'], ['Macro shortfall', '9', 'A breakfast took a meal’s place']].map(([label, value, hint]) => <Panel key={label}><p>{label}</p><h2>{value}</h2><small>{hint}</small></Panel>)}</div><Panel title="Kitchen List"><p>One line per item. Weights come from Sidi’s tables.</p><div className="av2-filters"><SearchBox placeholder="Search customer..." value={query} onChange={setQuery} /><Select label="All plans" values={[...new Set(kitchenRows.map(r => r[1]))]} value={plan} onChange={setPlan} /><Select label="All flags" values={[...new Set(kitchenRows.map(r => r[8]))]} value={flag} onChange={setFlag} /></div><DataTable headers={headers} rows={filtered.map(r => r.map((c, i) => i === 8 ? <Badge tone={c === 'No safe dish' ? 'red' : c === 'Chef pick' || c === 'Shortfall' ? 'amber' : c === 'Change veg' ? 'blue' : 'green'}>{c}</Badge> : c))} /></Panel></>}
    {tab === 'Counting' && <><Panel title="Mains per dish" actions={<Action icon={Download} onClick={() => downloadCsv('meal-counts-preview.csv', ['Dish', 'Type', 'Portions', 'Protein total', 'Carb total', 'Veg total', 'Sauce', 'Component changes'], counts)}>Export CSV</Action>}><p>Portions and total weights to cook for Tue 3 Nov</p><DataTable headers={['Dish', 'Type', 'Portions', 'Protein total', 'Carb total', 'Veg total', 'Sauce', 'Component changes']} rows={counts} /></Panel><div className="av2-columns"><Panel title="Breakfasts"><DataTable headers={['Breakfast', 'Regular', 'Large', 'Total']} rows={['Baked Egg and Veg', 'Biscoff Overnight Oats', 'Mix Berry Pancake'].map((n, i) => [n, [74, 52, 38][i], [6, 0, 2][i], [80, 52, 40][i]])} /></Panel><Panel title="Snacks"><DataTable headers={['Snack', 'Pieces']} rows={['Protein Ball', 'Hummus & Veg', 'Greek Yoghurt Cup'].map((n, i) => [n, [118, 97, 61][i]])} /></Panel></div></>}
    {tab === 'Overview' && <Panel title="Dietary overview"><p>Sample customer flags for the selected kitchen day.</p><DataTable headers={['Flag', 'Customers', 'Kitchen action']} rows={[['Nut allergy', 18, 'Avoid nuts in assigned recipes'], ['Dairy allergy', 12, 'Use a dairy-free recipe'], ['Mushroom exclusion', 9, 'Check component adaptations'], ['No safe dish', 1, 'Needs manual review']]} /></Panel>}
    {tab === 'Cook Plan' && <Panel title="Cook Plan"><p>Sample preparation totals grouped by component.</p><DataTable headers={['Component', 'Preparation', 'Source']} rows={counts.map(r => [r[0], `${r[2]} portions`, 'Preview snapshot'])} /></Panel>}
  </>;
}
function Subscription({
  meals
}) {
  const [dialog, setDialog] = useState(''),
    [week, setWeek] = useState(0),
    [editing, setEditing] = useState(false);
  const [diet, setDiet] = usePreviewState('diet', {
    allergies: ['All nuts'],
    exclusions: ['Mushroom', 'Coriander']
  });
  const [draftDiet, setDraftDiet] = useState(diet);
  const [picks, setPicks] = usePreviewState('picks', ['Baked Egg and Veg', 'Sweet and Sour Chicken', 'Kofta', 'Biscoff Overnight Oats', 'Creamy Chipotle Chicken', '', 'Savoury French Toast', 'Sweet Mustard Chicken', 'Thai Fish Curry']);
  const [draftPicks, setDraftPicks] = useState(picks);
  const toggle = (key, item) => setDraftDiet(d => ({
    ...d,
    [key]: d[key].includes(item) ? d[key].filter(v => v !== item) : [...d[key], item]
  }));
  return <><Heading title="Aisha Mattar" subtitle="Subscription #16893 · aishamattar@gmail.com"><Badge tone="green">Active</Badge><Badge tone="outline">Custom</Badge></Heading><div className="av2-tabs"><span>Overview</span><span>Delivery</span><span>Billing</span><span className="active">Meal picks</span></div>
    <div className="av2-stats av2-sub-stats"><Panel><p>Meals per day</p><strong>3 (breakfast counts as one)</strong></Panel><Panel><p>Allergies</p><div className="av2-badges">{diet.allergies.map(v => <Badge tone="red" key={v}>{v}</Badge>)}</div><button className="av2-text-button" onClick={() => {
          setDraftDiet(diet);
          setDialog('diet');
        }}>Edit allergies & exclusions</button></Panel><Panel><p>Exclusions</p><div className="av2-badges">{diet.exclusions.map(v => <Badge key={v}>{v}</Badge>)}</div></Panel><Panel><p>Picks this week</p><strong>{picks.filter(Boolean).length} of 9 sample slots</strong></Panel></div>
    <Panel title="Weekly Meal Selections" actions={<div className="av2-actions"><Action aria-label="Previous week" onClick={() => setWeek(w => w - 1)}>‹</Action><strong>Week of {2 + week * 7} Nov</strong><Action aria-label="Next week" onClick={() => setWeek(w => w + 1)}>›</Action><Action icon={Pencil} onClick={() => {
        setDraftPicks(picks);
        setEditing(true);
      }}>Edit picks</Action></div>}><p>Admins can change picks for a customer until the kitchen locks that day.</p>{week !== 0 && <Notice>Other weeks reuse the sample selections in this design preview.</Notice>}
      {['Monday', 'Tuesday', 'Wednesday', 'Thursday'].map((day, i) => <section className="av2-pick-day" key={day}><div className="av2-heading"><h3>{day} <small>{2 + i + week * 7} Nov</small></h3>{i === 0 ? <Badge tone="blue">Locked</Badge> : i === 2 ? <Badge>Skipped · no delivery</Badge> : <small>Customer deadline: Sat 31 Oct, 5:00 PM · CS can edit until 7:00 PM</small>}</div>{i === 2 ? <p>Skipped by the customer on 28 Oct. The pause flow moved the end date by one day.</p> : <div className="av2-pick-grid">{[0, 1, 2].map(j => {
            const index = (i === 3 ? 2 : i) * 3 + j;
            const name = picks[index];
            return <div key={j} className={`av2-pick ${!name ? 'av2-missing' : ''}`}><small>{j === 0 ? 'BREAKFAST' : 'MAIN'}</small><strong>{name || 'Not picked yet'}</strong>{name && <Badge tone={name === 'Kofta' ? 'amber' : 'green'}>{name === 'Kofta' ? 'Chef pick' : 'Customer'}</Badge>}</div>;
          })}</div>}</section>)}
    </Panel>
    {dialog === 'diet' && <Modal title="Allergies & exclusions" onClose={() => setDialog('')} footer={<><Action onClick={() => setDialog('')}>Cancel</Action><Action primary onClick={() => {
        setDiet(draftDiet);
        setDialog('');
      }}>Save</Action></>}><p>Aisha Mattar · Subscription #16893 <Badge tone="green">Confirmed</Badge></p><Notice>Imported from Sidi’s app on 2 Nov · confirmed by the customer on 3 Nov. Sample history for design review.</Notice><h3>Allergies</h3><p>Hard block: never offered or auto-assigned.</p><div className="av2-choice-chips">{['Gluten', 'Dairy', 'Egg', 'Soy', 'Sesame', 'Peanuts', 'All nuts', 'Seafood', 'Shrimps'].map(v => <button aria-pressed={draftDiet.allergies.includes(v)} key={v} onClick={() => toggle('allergies', v)}>{v}</button>)}</div><h3>Exclusions</h3><p>Warning: the customer chooses what the kitchen does.</p><div className="av2-choice-chips">{['Coriander', 'Mushroom', 'Capsicum', 'Raw onion', 'Raw tomato', 'Cabbage', 'Cauliflower', 'Beetroot', 'Eggplant', 'Legumes', 'A bit spicy'].map(v => <button aria-pressed={draftDiet.exclusions.includes(v)} key={v} onClick={() => toggle('exclusions', v)}>{v}</button>)}</div><Notice tone="amber">Preview only: changing these chips does not re-check live picks or notify customers.</Notice></Modal>}
    {editing && <Modal title="Edit meal picks" onClose={() => setEditing(false)} footer={<><Action onClick={() => setEditing(false)}>Cancel</Action><Action primary onClick={() => {
        setPicks(draftPicks);
        setEditing(false);
      }}>Save preview picks</Action></>}><p>Monday is locked. Choose sample meals for the open delivery days.</p>{[3, 4, 5, 6, 7, 8].map(i => <label className="av2-pick-select" key={i}>{i < 6 ? 'Tuesday' : 'Thursday'} · Slot {i % 3 + 1}<select value={draftPicks[i]} onChange={e => setDraftPicks(p => p.map((v, j) => j === i ? e.target.value : v))}><option value="">Not picked yet</option>{[...new Set([...meals.filter(m => m.status === 'Published').map(m => m.name), draftPicks[i]].filter(Boolean))].map(n => <option key={n}>{n}</option>)}</select></label>)}</Modal>}
  </>;
}
