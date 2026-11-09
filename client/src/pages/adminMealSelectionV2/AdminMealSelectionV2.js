import React, { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { MealLibrary, MealComposer, CyclePlanner, ComponentLibrary } from './WorkbookMealPages';
import { Panel, SearchBox, DataTable, Notice } from './components';
import '../../styles/matterChrome.css';
import './adminMealSelectionV2.css';
const BASE = '/admin/meal-selection-v2';
const STORAGE = 'matter-admin-v2:workbook-cycle-v2';
const EMPTY_CYCLE = { meals: [], source: '' };

// Owner: remove the bundled catalogue, retaining locally created meals and
// imports from other workbooks when upgrading an existing preview session.
function readCycle() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE));
    if (Array.isArray(saved?.meals)) return saved;
    const previous = JSON.parse(sessionStorage.getItem('matter-admin-v2:workbook-cycle-v1'));
    if (!Array.isArray(previous?.meals)) return EMPTY_CYCLE;
    if (previous.source !== 'April_Cycle_1_Meals_and_Exclusions.xlsx') return previous;
    return { meals: previous.meals.filter(meal => !/^APR1-/.test(meal.id)), source: '' };
  } catch { return EMPTY_CYCLE; }
}

export default function AdminMealSelectionV2() {
  const location = useLocation(), navigate = useNavigate();
  const contentRef = useRef(null);
  const [cycle, setCycle] = useState(readCycle);
  const [message, setMessage] = useState('');
  useEffect(() => { contentRef.current?.closest('main')?.scrollTo(0, 0); }, [location.pathname]);
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE, JSON.stringify(cycle));
      // Obsolete sample-only state is no longer used by these pages.
      ['workbook-cycle-v1', 'ingredients', 'diet', 'picks', 'kitchen-locked'].forEach(key => sessionStorage.removeItem(`matter-admin-v2:${key}`));
    } catch { /* In-memory editing remains available. */ }
  }, [cycle]);
  const route = location.pathname.slice(BASE.length).split('/').filter(Boolean);
  const page = route[0] || 'meals';
  if (!['ingredients', 'recipes', 'components', 'meals', 'weekly-menu', 'kitchen', 'subscriptions'].includes(page)) return <Navigate to={`${BASE}/meals`} replace />;
  return <div className="av2 av2-integrated" ref={contentRef}><div className="av2-page-body">
    {message && <div className="av2-feedback" role="status">{message}<button aria-label="Dismiss message" onClick={() => setMessage('')}><X size={16} /></button></div>}
    {page === 'meals' && (route[1] ? <MealComposer key={route[1]} meal={cycle.meals.find(m => m.id === route[1])} isNew={route[1] === 'new'} onSave={meal => {
      setCycle(current => ({ ...current, meals: current.meals.some(m => m.id === meal.id) ? current.meals.map(m => m.id === meal.id ? meal : m) : [...current.meals, meal] }));
      setMessage('Meal and component rules saved in this preview session.');
      navigate(`${BASE}/meals`);
    }} /> : <MealLibrary meals={cycle.meals} source={cycle.source} onImport={setCycle} />)}
    {page === 'weekly-menu' && <CyclePlanner meals={cycle.meals} source={cycle.source} onImport={setCycle} />}
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
