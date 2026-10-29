import React from 'react';
import { Download } from 'lucide-react';

const categories = [['breakfast', 'Breakfast'], ['meal', 'Main meals'], ['snack', 'Snacks']];
const fields = [['totalProteinWeight', 'Protein'], ['totalCarbWeight', 'Carb'], ['totalVegWeight', 'Veg']];
const kg = grams => (grams / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });

// Presentation only: countRows remains the source for exports and drill-downs.
export default function KitchenCountingGroups({ rows, onDownload }) {
  return <div className="kitchen-count-groups">{categories.map(([category, label]) => {
    const items = rows.filter(row => row.category === category);
    if (!items.length) return null;
    const totals = Object.fromEntries(fields.map(([field]) => [field, items.reduce((sum, row) => sum + row[field], 0)]));
    const count = items.reduce((sum, row) => sum + row.count, 0);
    return <section key={category} className="kitchen-count-group" aria-label={`${label} cook counts`}>
      <div className="kitchen-group-heading">
        <div><h3>{label}</h3><strong>{count}</strong><span>portions</span></div>
        {fields.map(([field, title]) => <div key={field} className="kitchen-group-total"><span>{title}</span><strong>{kg(totals[field])} <small>kg</small></strong></div>)}
      </div>
      <div className="kitchen-group-rows">{items.map(row => <div className="kitchen-count-row" key={row.mealName}>
        <strong className="kitchen-portion-number"><span className="sr-only">Portions: </span>{row.count}</strong>
        <div className="kitchen-count-dish">{row.mealName.endsWith(' (LARGE)') ? <>{row.mealName.slice(0, -8)} <span className="kitchen-large-label">Large</span></> : row.mealName}</div>
        {fields.map(([field, title]) => <div key={field} className={`kitchen-weight-bar kitchen-weight-${field}`}>
          <span className="kitchen-mobile-weight-label">{title}</span>
          <strong title={`${Math.round(row[field])} g`}>{kg(row[field])} <small>kg</small></strong>
          <span className="kitchen-bar-track" aria-hidden="true"><i style={{ width: `${totals[field] ? Math.min(100, row[field] / totals[field] * 100) : 0}%` }} /></span>
        </div>)}
        <button type="button" onClick={() => onDownload(row.category, row.mealName)} aria-label={`Download customers for ${row.mealName}`} title={`Download customers for ${row.mealName}`} className="kitchen-row-download"><Download size={16} /></button>
      </div>)}</div>
    </section>;
  })}</div>;
}
