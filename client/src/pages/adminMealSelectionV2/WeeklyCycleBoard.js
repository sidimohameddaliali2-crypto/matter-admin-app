import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Save, Check, Upload, Copy, History, Eye, X, GripVertical } from 'lucide-react';
import { Action, Badge, Tabs, SearchBox, Modal, Notice } from './components';
import { componentName, mealType, mealFormat } from './workbookMeals';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const GROUPS = ['Breakfast', 'Main', 'Sub', 'Snack'];
const STORAGE = 'matter-admin-v2:weekly-board-v1';
const emptyBoard = () => DAYS.map(() => GROUPS.map(() => []));
const slotFor = meal => mealFormat(meal) === 'Breakfast' ? 0 : mealFormat(meal) === 'Snack' ? 3 : /SUB/.test(meal.category) ? 2 : 1;
function seedBoard(meals) {
  const board = emptyBoard();
  meals.forEach(meal => {
    const days = meal.day === 'DAY 6 & 7' ? [5, 6] : [/^DAY ([1-5])$/.test(meal.day) ? Number(meal.day.slice(-1)) - 1 : -1];
    days.filter(day => day >= 0).forEach(day => board[day][slotFor(meal)].push({ mealId: meal.id, isNew: false }));
  });
  return board;
}
function readDrafts() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE)) || {}; } catch { return {}; }
}

export default function WeeklyCycleBoard({ meals, source, onImport, importDialog }) {
  const [menu, setMenu] = useState('Main menu'), [week, setWeek] = useState('Week 1');
  const [boards, setBoards] = useState(readDrafts);
  const [query, setQuery] = useState(''), [protein, setProtein] = useState(''), [slot, setSlot] = useState('');
  const [showWeekend, setShowWeekend] = useState(false), [importing, setImporting] = useState(false), [history, setHistory] = useState(false);
  const [selected, setSelected] = useState(null), [targetDay, setTargetDay] = useState('0'), [targetSlot, setTargetSlot] = useState('1');
  const [message, setMessage] = useState('');
  const [dragMealId, setDragMealId] = useState(null), [dropTarget, setDropTarget] = useState(null);
  const key = `${menu}:${week}`;
  const board = boards[key] || (menu === 'Main menu' && week === 'Week 1' ? seedBoard(meals) : emptyBoard());
  const byId = new Map(meals.map(meal => [meal.id, meal]));
  useEffect(() => { try { sessionStorage.setItem(STORAGE, JSON.stringify(boards)); } catch { /* In-memory preview remains usable. */ } }, [boards]);
  const changeBoard = update => setBoards(current => ({ ...current, [key]: update(current[key] || (menu === 'Main menu' && week === 'Week 1' ? seedBoard(meals) : emptyBoard())) }));
  const entryCount = board.reduce((total, day) => total + day.flat().filter(entry => byId.has(entry.mealId)).length, 0);
  const library = meals.filter(meal => meal.name.toLowerCase().includes(query.toLowerCase()) && (!protein || mealType(meal) === protein) && (!slot || slotFor(meal) === Number(slot)));
  const addMeal = (meal, dayIndex, groupIndex) => {
    changeBoard(current => current.map((day, di) => di !== dayIndex ? day : day.map((group, gi) => gi !== groupIndex ? group : [...group, { mealId: meal.id, isNew: false }])));
    setMessage(`${meal.name} added to ${DAYS[dayIndex]} · ${GROUPS[groupIndex]}.`);
  };
  const add = () => {
    addMeal(selected, Number(targetDay), Number(targetSlot));
    setSelected(null);
  };
  const clearDrag = () => { setDragMealId(null); setDropTarget(null); };
  useEffect(() => { setDragMealId(null); setDropTarget(null); }, [menu, week]);
  const dragOver = (event, dayIndex, groupIndex = null) => {
    if (!dragMealId || !byId.has(dragMealId)) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDropTarget(current => current?.day === dayIndex && current?.group === groupIndex ? current : { day: dayIndex, group: groupIndex });
  };
  const drop = (event, dayIndex, groupIndex = null) => {
    event.preventDefault(); event.stopPropagation();
    const meal = byId.get(dragMealId);
    if (meal && event.dataTransfer.getData('application/x-matter-meal') === meal.id) addMeal(meal, dayIndex, groupIndex ?? slotFor(meal));
    clearDrag();
  };
  const dragLeave = event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
  };
  return <div className="av2-weekly-board">
    <div className="av2-page-heading"><div><h1>Cycle Menu Planner</h1><p>One menu per group of plans. Add meals to each day and mark new dishes.</p></div><Badge>Draft</Badge></div>
    <div className="av2-actions av2-toolbar">
      <Action icon={Save} onClick={() => { changeBoard(current => current); setMessage('Draft saved in this preview session.'); }}>Save draft</Action>
      <Action primary icon={Check} disabled title="Publishing requires verified live recipe links">Publish</Action>
      <Action icon={Upload} onClick={() => setImporting(true)}>Import meal names</Action>
      <Action icon={Copy} onClick={() => { const other = week === 'Week 1' ? 'Week 2' : 'Week 1'; setBoards(current => ({ ...current, [`${menu}:${other}`]: JSON.parse(JSON.stringify(board)) })); setWeek(other); setMessage(`Copied draft to ${other}.`); }}>Duplicate week</Action>
      <Action icon={History} onClick={() => setHistory(true)}>History</Action>
      <Link className="av2-action" to="/menu-select-v2"><Eye size={14}/>Preview as customer</Link>
    </div>
    <Tabs values={['Main menu', 'Matter Core menu']} value={menu} onChange={setMenu}/>
    <div className="av2-section-bar"><Tabs values={['Week 1', 'Week 2']} value={week} onChange={setWeek}/><label className="av2-weekend-toggle"><input type="checkbox" checked={showWeekend} onChange={event => setShowWeekend(event.target.checked)}/>Show weekend</label></div>
    <Notice tone="amber"><strong>Recipe links need review</strong><p>This is a local draft from {source}. Publishing is unavailable until live Supy recipe links and dietary data are verified.</p></Notice>
    {message && <div className="av2-feedback" role="status">{message}<button aria-label="Dismiss board message" onClick={() => setMessage('')}><X size={15}/></button></div>}
    <div className={`av2-board-layout ${dragMealId ? 'av2-drag-active' : ''}`}><div className={`av2-board ${showWeekend ? 'av2-full-week' : ''}`}>
      {board.slice(0, showWeekend ? 7 : 5).map((day, di) => <section className={`av2-day ${dropTarget?.day === di && dropTarget.group === null ? 'av2-day-drop-target' : ''}`} key={DAYS[di]} aria-label={`${DAYS[di]} meal drop area`} onDragOver={event => dragOver(event, di)} onDrop={event => drop(event, di)} onDragLeave={dragLeave}>
        <div className="av2-day-title"><strong>{DAYS[di]}</strong><small>{di < 5 ? `Cycle day ${di + 1}` : 'Cycle day 6 & 7'}</small><small className="av2-blue-text">{day.flat().filter(entry => byId.has(entry.mealId)).length} meals · draft</small></div>
        {day.map((group, gi) => <div className={`av2-meal-group av2-group-${gi} ${dropTarget?.day === di && dropTarget.group === gi ? 'av2-slot-drop-target' : ''}`} key={GROUPS[gi]} aria-label={`${DAYS[di]} ${GROUPS[gi]} drop area`} onDragOver={event => dragOver(event, di, gi)} onDrop={event => drop(event, di, gi)} onDragLeave={dragLeave}>
          <div className="av2-heading"><span>{GROUPS[gi].toUpperCase()}</span><Badge tone="outline">{group.filter(entry => byId.has(entry.mealId)).length}</Badge></div>
          {group.map((entry, index) => {
            const meal = byId.get(entry.mealId);
            if (!meal) return null;
            return <div className="av2-meal-card" key={`${entry.mealId}-${index}`}>
              <Link to={`/admin/meal-selection-v2/meals/${meal.id}`}><strong>{meal.name}</strong></Link>
              <small>{mealType(meal) || GROUPS[gi]} · {componentName(meal, 'Carb') === '—' ? meal.temperature : componentName(meal, 'Carb')}</small>
              {entry.isNew && <Badge tone="blue">New</Badge>}
              <button className="av2-card-remove" aria-label={`Remove ${meal.id} from ${DAYS[di]}`} onClick={() => changeBoard(current => current.map((value, d) => d !== di ? value : value.map((list, g) => g !== gi ? list : list.filter((_, i) => i !== index))))}><X size={11}/></button>
              <label className="av2-new-label"><input type="checkbox" aria-label={`Mark ${meal.id} as new on ${DAYS[di]}`} checked={entry.isNew} onChange={event => changeBoard(current => current.map((value, d) => d !== di ? value : value.map((list, g) => g !== gi ? list : list.map((item, i) => i !== index ? item : { ...item, isNew: event.target.checked }))))}/>New</label>
            </div>;
          })}
          {!group.length && <small className="av2-board-empty">Drag a meal here</small>}
          {dropTarget?.day === di && dropTarget.group === gi && <small className="av2-drop-hint">Drop into {GROUPS[gi]}</small>}
        </div>)}
      </section>)}
    </div><aside className="av2-library"><h3>Available Meals</h3><small className="av2-drag-instructions">Drag a meal onto a day or meal section. Click to choose a day instead.</small><SearchBox placeholder="Search meals..." value={query} onChange={setQuery}/>
      <select aria-label="Library meal type" value={protein} onChange={event => setProtein(event.target.value)}><option value="">All proteins</option>{['Chicken', 'Beef', 'Fish'].map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Library meal slot" value={slot} onChange={event => setSlot(event.target.value)}><option value="">All meal slots</option>{GROUPS.map((value, index) => <option key={value} value={index}>{value}</option>)}</select>
      <small>{library.length} meals in library</small>
      {library.map(meal => <button type="button" className={`av2-library-card ${dragMealId === meal.id ? 'av2-library-card-dragging' : ''}`} key={meal.id} draggable onDragStart={event => { event.dataTransfer.setData('application/x-matter-meal', meal.id); event.dataTransfer.effectAllowed = 'copy'; setDragMealId(meal.id); }} onDragEnd={clearDrag} onClick={() => { setSelected(meal); setTargetSlot(String(slotFor(meal))); }}><span className="av2-library-card-title"><GripVertical size={15} aria-hidden="true"/><strong>{meal.name}</strong></span><span><Badge tone="outline">{GROUPS[slotFor(meal)]}</Badge>{mealType(meal) && <Badge>{mealType(meal)}</Badge>}</span><small>{componentName(meal, 'Carb')}</small><small>Drag to a day +</small></button>)}
      {!library.length && <small>No meals match these filters.</small>}
    </aside></div>
    <p className="av2-table-hint">{entryCount} meal assignments · {menu} · {week} · local preview</p>
    {selected && <Modal title={`Add ${selected.name}`} onClose={() => setSelected(null)} footer={<><Action onClick={() => setSelected(null)}>Cancel</Action><Action primary onClick={add}>Add to draft</Action></>}><div className="av2-form-grid"><label>Delivery day<select aria-label="Delivery day" value={targetDay} onChange={event => setTargetDay(event.target.value)}>{DAYS.map((value, index) => <option key={value} value={index}>{value}</option>)}</select></label><label>Meal slot<select aria-label="Meal slot" value={targetSlot} onChange={event => setTargetSlot(event.target.value)}>{GROUPS.map((value, index) => <option key={value} value={index}>{value}</option>)}</select></label></div></Modal>}
    {history && <Modal title="Menu history" onClose={() => setHistory(false)} footer={<Action onClick={() => setHistory(false)}>Close</Action>}><p>{menu} · {week}</p><Notice>No published versions in this local preview. Use Save draft to retain your board changes for this session.</Notice></Modal>}
    {importing && importDialog(() => setImporting(false), data => { onImport(data); setBoards({}); setMenu('Main menu'); setWeek('Week 1'); setMessage('Imported meal cycle into the draft board.'); })}
  </div>;
}
