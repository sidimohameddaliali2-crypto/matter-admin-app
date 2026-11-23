import React, { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { MealLibrary, MealComposer, CyclePlanner, ComponentLibrary } from './WorkbookMealPages';
import { Panel, SearchBox, DataTable, Notice } from './components';
import '../../styles/matterChrome.css';
import './adminMealSelectionV2.css';
import useMealCreationState from './useMealCreationState';
import { mealCreationStore } from '../../utils/mealCreationStore';
import { mealsForCycle } from '../../utils/savedMealCycles';
const BASE = '/admin/meal-selection-v2';

export default function AdminMealSelectionV2() {
  const location = useLocation(), navigate = useNavigate();
  const contentRef = useRef(null);
  const alive = useRef(true), view = useRef({ path: location.pathname, version: 0 });
  if (view.current.path !== location.pathname) view.current = { path: location.pathname, version: view.current.version + 1 };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const saved = useMealCreationState();
  const cycle = saved.data?.catalogue;
  const [message, setMessage] = useState('');
  const [selectedCycleId, setSelectedCycleId] = useState('');
  useEffect(() => { contentRef.current?.closest('main')?.scrollTo(0, 0); }, [location.pathname]);
  const importMeals = async catalogue => {
    const next = await mealCreationStore.save({ catalogue, skipDuplicates: true });
    const imported = next.cycles?.find(item => item.source === catalogue.source && item.meals.some(entry => catalogue.meals.some(meal => meal.id === entry.sourceMealId)));
    if (imported) setSelectedCycleId(imported.id);
    setMessage('Meals and cycle saved. Existing cycles remain available when creating weekly menus.');
  };
  const route = location.pathname.slice(BASE.length).split('/').filter(Boolean);
  const page = route[0] || 'meals';
  if (!cycle || saved.status === 'loading' || saved.status === 'idle') return <div className="av2 av2-integrated"><div className="av2-page-body">{saved.error ? <Notice tone="red">{saved.error}<button onClick={() => mealCreationStore.load().catch(() => {})}>Retry loading meals</button></Notice> : <p role="status">Loading saved meals and cycles…</p>}</div></div>;
  if (!['ingredients', 'recipes', 'components', 'meals', 'weekly-menu', 'kitchen', 'subscriptions'].includes(page)) return <Navigate to={`${BASE}/meals`} replace />;
  const cycles = saved.data.cycles || [];
  const selectedCycle = cycles.find(item => item.id === selectedCycleId) || (page === 'weekly-menu' ? cycles[0] : null);
  const cycleSelector = cycles.length ? <label className="av2-cycle-selector">Saved cycle<select aria-label="Saved cycle" value={selectedCycle?.id || ''} onChange={event => setSelectedCycleId(event.target.value)}>{page !== 'weekly-menu' && <option value="">All saved meals</option>}{cycles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null;
  return <div className="av2 av2-integrated" ref={contentRef}><div className="av2-page-body">
    {(saved.error || message) && <div className="av2-feedback" role="status">{saved.error || message}<button aria-label="Dismiss message" onClick={() => setMessage('')}><X size={16} /></button></div>}
    {page === 'meals' && (route[1] ? <MealComposer key={route[1]} meal={cycle.meals.find(m => m.id === ((saved.data.aliases || []).find(alias => alias.from === route[1])?.to || route[1]))} isNew={route[1] === 'new'} revision={saved.data.revision} onSave={async (meal, revision) => {
      const version = view.current.version;
      await mealCreationStore.save({ catalogue: { meals: [meal] } }, revision);
      if (!alive.current || version !== view.current.version) return;
      if (route[1] === 'new') setSelectedCycleId('');
      setMessage('Meal and component rules saved to the library.');
      navigate(`${BASE}/meals`);
    }} /> : <MealLibrary meals={mealsForCycle(cycle.meals, selectedCycle, cycles)} source={selectedCycle?.source || (cycles.length ? 'All saved cycles' : cycle.source)} onImport={importMeals} cycleSelector={cycleSelector} />)}
    {page === 'weekly-menu' && <CyclePlanner key={selectedCycle?.id || 'legacy'} meals={mealsForCycle(cycle.meals, selectedCycle, cycles)} libraryMeals={cycle.meals} source={selectedCycle?.source || (cycles.length ? 'All saved cycles' : cycle.source)} onImport={importMeals} cycleSelector={cycleSelector} boards={selectedCycle?.boards || saved.data.boards} revision={saved.data.revision} onSaveBoards={async boards => { const result = await mealCreationStore.save({ boards, ...(selectedCycle ? { cycleId: selectedCycle.id } : {}) }); return { ...result, boards: selectedCycle ? result.cycles.find(item => item.id === selectedCycle.id).boards : result.boards }; }} />}
    {page === 'recipes' && <Navigate to={`${BASE}/components`} replace />}
    {page === 'components' && <ComponentLibrary meals={cycle.meals} />}
    {page === 'ingredients' && <EmptyRecords title="Ingredients Management" description="Ingredients from Supy will appear here when connected." headers={['Ingredient Name', 'Category', 'Cost per Gram', 'Allergens', 'Exclusions']} />}
    {page === 'kitchen' && <EmptyRecords title="Kitchen Dashboard" description="Kitchen data will appear here when connected to your operations." headers={['Customer', 'Plan', 'Item', 'Protein', 'Carb', 'Veg', 'kcal', 'Flags']} />}
    {page === 'subscriptions' && <EmptyRecords title="Subscription Meal Picks" description="Select a connected subscription to view its meal selections." headers={['Customer', 'Subscription', 'Meal selections']} />}
  </div></div>;
}

function EmptyRecords({ title, description, headers }) {
  const [query, setQuery] = useState('');
  return <><div className="av2-page-heading"><div><h1>{title}</h1><p>{description}</p></div></div>
    <Notice>No data connected yet.</Notice>
    <Panel><div className="av2-filters"><SearchBox placeholder="Search records..." value={query} onChange={setQuery} /></div><DataTable headers={headers} rows={[]} empty="No records yet." /></Panel>
  </>;
}
