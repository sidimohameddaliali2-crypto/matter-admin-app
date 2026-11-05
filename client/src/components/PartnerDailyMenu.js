import React, { useState } from 'react';

const heading = { fontFamily: "'Archivo Black', sans-serif" };
const labels = { oats: 'Oats', 'wraps-buns': 'Wraps/Buns', snack: 'Snack', bowl: 'Bowl', main: 'Main' };
const proteins = ['Chicken', 'Beef', 'Fish'];
const titleCase = name => String(name || '').trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const initials = name => String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();

// Match the existing partner menu's cards and grouping while keeping the cart
// scoped to the active delivery day. Unknown meal types remain visible too.
export default function PartnerDailyMenu({ items, cart, placed, onQuantityChange }) {
  const [filter, setFilter] = useState('all');
  const types = [...Object.keys(labels), ...new Set(items.map(item => item.mealType || 'other').filter(type => !labels[type]))];
  const groups = types.map(type => ({type, label: labels[type] || titleCase(type), items: items.filter(item => (item.mealType || 'other') === type)})).filter(group => group.items.length);
  const renderCard = item => {
    const quantity = cart[item._id]?.quantity || 0;
    const validPrice = item.price != null && Number.isFinite(Number(item.price)) && Number(item.price) >= 0;
    return <article key={item._id} className="flex items-center gap-3 bg-[#051747] rounded-[18px] px-3.5 py-3.5 border-[1.5px]"
      style={{borderColor: quantity ? '#bcf679' : '#12275e'}}>
      <div aria-hidden="true" className="w-[42px] h-[42px] rounded-[13px] flex items-center justify-center flex-none text-[14px]"
        style={{...heading, background: quantity ? '#bcf679' : '#12275e', color: quantity ? '#051747' : '#a8ccf5'}}>{initials(item.name)}</div>
      <div className="min-w-0 flex-1">
        <h4 className="text-[13.5px] font-bold break-words">{titleCase(item.name)}</h4>
        {item.mealType && <div className="inline-block mt-1 rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide bg-[#12275e] text-[#a8ccf5]">{labels[item.mealType] || titleCase(item.mealType)}</div>}
        {(item.description || item.category) && <p className="text-[11px] text-[#a8ccf5] mt-0.5">{item.description || item.category}</p>}
        <p className="text-[12px] font-bold text-[#bcf679] mt-1">{validPrice ? 'AED ' + Number(item.price).toFixed(2) : 'Price TBD'}</p>
      </div>
      <div className="flex items-center gap-0.5 bg-[#0a1230] rounded-full p-0.5 flex-none">
        <button type="button" aria-label={'Remove ' + item.name} disabled={!quantity || placed} onClick={() => onQuantityChange(item, -1)}
          className="w-[30px] h-[30px] rounded-full text-[#ede5de] text-[17px] hover:bg-[#12275e] disabled:opacity-40">−</button>
        <span aria-label={'Quantity for ' + item.name} className="min-w-[18px] text-center text-[13px] font-bold" style={{color: quantity ? '#bcf679' : '#a8ccf5'}}>{quantity}</span>
        <button type="button" aria-label={'Add ' + item.name} disabled={placed || !validPrice} onClick={() => onQuantityChange(item, 1)}
          className="w-[30px] h-[30px] rounded-full bg-[#bcf679] text-[#051747] text-[17px] hover:opacity-90 disabled:opacity-40">+</button>
      </div>
    </article>;
  };
  return <div>
    {!!items.length && <div className="flex flex-wrap gap-1.5 mb-3.5" aria-label="Meal categories">
      {[{type: 'all', label: 'All', items}, ...groups].map(group => <button key={group.type} type="button" aria-label={'Filter ' + group.label} aria-pressed={filter === group.type}
        onClick={() => setFilter(group.type)} className="rounded-full px-3 py-1.5 text-[11.5px] font-bold border-[1.5px]"
        style={{background: filter === group.type ? '#bcf679' : '#0a1230', color: filter === group.type ? '#051747' : '#a8ccf5', borderColor: filter === group.type ? '#bcf679' : '#12275e'}}>
        {group.label} <span className="ml-1.5">{group.items.length}</span>
      </button>)}
    </div>}
    <div className="flex flex-col gap-5">
      {groups.filter(group => filter === 'all' || filter === group.type).map(group => <section key={group.type} aria-label={group.label + ' meals'}>
        <h4 className="text-[11px] font-bold tracking-[0.12em] uppercase text-[#a8ccf5] mb-2.5">{group.label}</h4>
        {group.type === 'main' ? <div className="space-y-4">
          {[...proteins, 'Other'].map(protein => {
            const meals = group.items.filter(item => protein === 'Other' ? !proteins.includes(item.category) : item.category === protein);
            return meals.length > 0 && <div key={protein}>
              <h5 className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#bcf679] mb-2">{protein}</h5>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{meals.map(renderCard)}</div>
            </div>;
          })}
        </div> : <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{group.items.map(renderCard)}</div>}
      </section>)}
    </div>
  </div>;
}
