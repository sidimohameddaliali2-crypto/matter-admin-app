import logo from './menuPdfLogo.js';
import footerLogo from './menuPdfFooterLogo.js';
import { selectionComponentDetails } from './selectionComponentDetails.js';
import { toTitleCase } from './textFormat.js';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const dateKey = value => {
  // Date-picker values are local calendar dates, not UTC instants. Converting
  // Dubai midnight to ISO would incorrectly print the previous delivery day.
  const text = value instanceof Date && !Number.isNaN(value.getTime())
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : clean(value).slice(0, 10);
  const parsed = new Date(`${text}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : '';
};
const typeOf = value => ['lunch', 'dinner'].includes(clean(value).toLowerCase()) ? 'main' : clean(value).toLowerCase() || 'main';
const words = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN'];
const nameOf = value => {
  const text = clean(value);
  return text && text === text.toUpperCase() ? toTitleCase(text).replace(/\bBbq\b/g, 'BBQ') : text;
};
const join = values => [...new Set(values.map(clean).filter(Boolean))].join(' · ');
const rank = { main: 0, breakfast: 1, snack: 2 };
export const menuPdfDateRange = menu => [...new Set([menu.startDate, menu.endDate].map(dateKey).filter(Boolean))]
  .map(date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })).join(' — ');
const sortMeals = meals => meals.map((meal, index) => ({ ...meal, index }))
  .sort((a, b) => (rank[a.type] ?? 0) - (rank[b.type] ?? 0) || a.index - b.index);

const describe = (item, selected = {}) => join([
  selected.description || item.description || item.ingredients,
  selected.proteinChoice ? `Protein: ${selected.proteinChoice}` : '',
  selected.carbChoice || item.carbs,
  selected.vegChoice || item.veg,
  selected.sauceChoice || item.sauce,
  item.garnish,
  // Keep declared public allergens in the small description line when present.
  // Styling must not discard the food information in the existing export.
  clean(Array.isArray(item.allergens) ? item.allergens.join(', ') : item.allergens)
    ? `Allergens: ${clean(Array.isArray(item.allergens) ? item.allergens.join(', ') : item.allergens)}` : '',
]);

export function menuPdfSections(menu) {
  const days = new Map();
  for (const row of menu.meals || []) {
    const date = dateKey(row.date);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, meals: [] });
    for (const item of row.items || []) {
      if (!item || typeof item !== 'object') continue;
      const type = typeOf(row.mealType || item.mealType);
      // Snacks on dated menus are kitchen-only, as in the existing menu export.
      if (type === 'snack') continue;
      days.get(date).meals.push({ name: nameOf(item.mealName), description: describe(item), type });
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map(day => ({ ...day, message: day.meals.length ? '' : 'No menu items listed', meals: sortMeals(day.meals) }));
}

export function selectionPdfSections(customer, menu, dates = []) {
  const meals = customer.selectedMeals || [];
  const skips = (customer.skippedDays || []).filter(day => !day.resumedAt);
  const keys = [...new Set([...dates.map(dateKey), ...meals.map(meal => dateKey(meal.date || meal.menuItemId?.itemDate)), ...skips.map(day => dateKey(day.date))])].filter(Boolean).sort();
  return keys.map(date => {
    const skip = skips.find(day => dateKey(day.date) === date);
    const paused = skip && ['success', 'already_paused'].includes(skip.pauseStatus);
    const message = skip ? (paused ? `Paused${skip.resumeDate ? ` — resume ${dateKey(skip.resumeDate)}` : ''}`
      : skip.pauseStatus === 'failed' ? 'Pause not applied — contact customer service'
        : skip.pauseStatus === 'declined' ? 'Skipped — delivery not paused'
          : skip.pauseStatus === 'pending' ? 'Pause awaiting confirmation' : 'Skip recorded — pause status unavailable') : '';
    const catalogue = (menu.meals || []).filter(row => dateKey(row.date) === date).flatMap(row =>
      (row.items || []).filter(item => item && typeof item === 'object').map(item => ({ ...item, mealType: row.mealType || item.mealType })));
    return { date, message, meals: paused ? [] : sortMeals(meals.filter(meal => dateKey(meal.date || meal.menuItemId?.itemDate) === date).map(meal => {
      const id = clean(meal.menuItemId?._id || meal.menuItemId);
      const matches = catalogue.filter(item => id ? clean(item._id) === id
        : item.mealName === meal.mealName && typeOf(item.mealType) === typeOf(meal.mealType));
      const item = matches.length === 1 ? matches[0] : (meal.menuItemId && typeof meal.menuItemId === 'object' ? meal.menuItemId : {});
      const details = selectionComponentDetails(meal);
      const acknowledged = !meal.isAutoAssigned && (meal.preferenceConflict?.length || details.some(detail => detail.action === 'kept'));
      return { name: nameOf(meal.mealName || item.mealName || 'Meal'), description: describe(item, meal),
        type: typeOf(meal.mealType || item.mealType), quantity: Number(meal.quantity) || 1,
        notes: join([meal.isAutoAssigned ? 'Auto assigned' : 'Selected', meal.isUpcomingPlan ? 'Upcoming plan' : '',
          acknowledged ? 'Exclusion acknowledged' : '', ...details.map(detail => `${detail.label}: ${detail.detail}`)]),
      };
    })) };
  });
}

const colors = { paper: [239, 233, 227], navy: [5, 23, 71], ink: [48, 48, 48], muted: [99, 99, 99], light: [138, 138, 138] };
const W = 210, H = 297, CENTER = W / 2, WIDTH = 170, BOTTOM = 267;

// Both downloads use the sample's warm paper, centered typography and navy
// headings. Measure all content and fit the complete menu onto one A4 page.
export function drawMenuPdf(pdf, { title = 'Weekly menu', titleBold = false, customerName = '', subtitle = '', sections = [], mergeWeekends = false }) {
  let center = CENTER;
  const style = (size, color = colors.ink, bold = false, spacing = 0) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal');
    pdf.setFontSize(size); pdf.setTextColor(...color); pdf.setCharSpace(spacing);
  };
  const centered = (text, y) => {
    const spacing = pdf.getCharSpace();
    if (!spacing) return pdf.text(text, center, y, { align: 'center', lineHeightFactor: 1.12 });
    // jsPDF's centered alignment omits character spacing from its width.
    // Include it explicitly so tracked headings share the logo's center.
    const lines = Array.isArray(text) ? text : [text];
    lines.forEach((line, index) => {
      const width = pdf.getTextWidth(line) + Math.max(0, line.length - 1) * spacing;
      pdf.text(line, center - width / 2, y + index * pdf.getFontSize() * 25.4 / 72 * 1.12);
    });
  };
  const wrap = (text, size, width = WIDTH) => { style(size); return pdf.splitTextToSize(clean(text), width); };
  const trackedLines = (text, size, bold, spacing, width) => {
    style(size, colors.ink, bold);
    const lines = []; let line = '';
    for (const word of clean(text).toUpperCase().split(' ')) {
      for (const part of pdf.splitTextToSize(word, 80)) {
        const candidate = line ? `${line} ${part}` : part;
        if (line && pdf.getTextWidth(candidate) + (candidate.length - 1) * spacing > width) { lines.push(line); line = part; }
        else line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  };
  const pageWord = page => words[page - 1] || String(page);
  let y = 38;
  const beginPage = () => {
    pdf.setFillColor(...colors.paper); pdf.rect(0, 0, W, H, 'F');
    const [left, top, right, bottom] = footerLogo.bounds;
    const iconSize = 6.5;
    const scale = iconSize / Math.max(right - left + 1, bottom - top + 1);
    // Embed the supplied bytes unchanged and clip only the screenshot margin.
    pdf.saveGraphicsState();
    pdf.rect(CENTER - iconSize / 2, 278.5 - iconSize / 2, iconSize, iconSize);
    pdf.clip(); pdf.discardPath();
    pdf.addImage(footerLogo.dataUrl, 'PNG', CENTER - (left + right + 1) / 2 * scale,
      278.5 - (top + bottom + 1) / 2 * scale, footerLogo.width * scale, footerLogo.height * scale);
    pdf.restoreGraphicsState();
    style(5.8, colors.light, false, 0.8); centered('ONE', 285.5);
    {
      pdf.addImage(logo, 'PNG', CENTER - 11, 14, 22, 4.13);
      pdf.setDrawColor(...colors.navy); pdf.setLineWidth(0.12); pdf.line(CENTER - 19.5, 21.5, CENTER + 19.5, 21.5);
      const lines = trackedLines(title, 6.8, titleBold, 1.1, 158);
      style(6.8, colors.ink, titleBold, 1.1); centered(lines, 26.5);
      const lastTitleY = 26.5 + (lines.length - 1) * 2.7;
      let lastHeaderY = lastTitleY;
      for (const caption of [customerName, subtitle].filter(Boolean)) {
        const subtitles = wrap(caption, 6.5, 158);
        style(6.5, colors.muted); centered(subtitles, lastHeaderY + 4.5);
        lastHeaderY += 4.5 + (subtitles.length - 1) * 2.6;
      }
      y = Math.max(38, lastHeaderY + 9.5);
    }
  };
  beginPage();
  const bodyTop = y;
  const days = sections.map((section, index) => ({ ...section, number: index + 1 }));
  if (mergeWeekends) for (let i = 0; i < days.length - 1; i++) {
    const day = days[i], next = days[i + 1];
    const dt = new Date(`${day.date}T00:00:00Z`), following = new Date(dt); following.setUTCDate(dt.getUTCDate() + 1);
    if (dt.getUTCDay() === 6 && following.toISOString().slice(0, 10) === next.date && !day.message && !next.message
      && day.meals.length && JSON.stringify(day.meals) === JSON.stringify(next.meals)) {
      day.weekend = true; day.lastNumber = next.number; days.splice(i + 1, 1);
    }
  }

  const dayLabel = day => day.weekend
    ? `THE WEEKEND — DAYS ${pageWord(day.number)} & ${pageWord(day.lastNumber)}`
    : `DAY ${pageWord(day.number)} — ${new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }).toUpperCase()}`;
  const measure = (scale, width) => days.map(day => {
    let previousType = 'main';
    const headings = trackedLines(dayLabel(day), 6.8 * scale, true, 0.7 * scale, width);
    const meals = (day.meals || []).map(meal => {
      const label = meal.type !== 'main' && meal.type !== previousType ? meal.type.toUpperCase() : '';
      previousType = meal.type;
      return { ...meal, label };
    });
    const message = day.message || (!meals.length ? 'No meals selected' : '');
    if (message) meals.unshift({ name: message });
    const blocks = meals.map(meal => {
      const names = wrap(`${meal.name || 'Meal'}${meal.quantity > 1 ? ` ×${meal.quantity}` : ''}`, 12.4 * scale, width);
      const description = meal.description ? wrap(meal.description, 7.8 * scale, width) : [];
      // The customer-selection heading already identifies ordinary selections.
      // Keep all non-default assignment, plan and acknowledgement details.
      const notes = meal.notes && meal.notes !== 'Selected' ? wrap(meal.notes, 6.6 * scale, width) : [];
      return { ...meal, names, description, notes,
        height: scale * ((meal.label ? 3.3 : 0) + names.length * 4.6
          + (description.length ? 0.4 + description.length * 3.1 : 0)
          + (notes.length ? 0.4 + notes.length * 2.7 : 0) + 0.8) };
    });
    const headingHeight = scale * (4.5 + (headings.length - 1) * 2.7);
    return { ...day, headings, blocks, headingHeight, height: headingHeight + blocks.reduce((sum, block) => sum + block.height, 0) + 2.8 * scale };
  });
  const columnsFor = (layout, count) => {
    if (count === 1 || layout.length < 2) return [layout];
    const total = layout.reduce((sum, day) => sum + day.height, 0);
    let left = 0, split = 1, best = Infinity;
    for (let i = 1; i < layout.length; i++) {
      left += layout[i - 1].height;
      const height = Math.max(left, total - left);
      if (height < best) { best = height; split = i; }
    }
    return [layout.slice(0, split), layout.slice(split)];
  };
  const available = BOTTOM - bodyTop;
  const fit = count => {
    const width = count === 1 ? WIDTH : 84;
    const candidate = scale => {
      const columns = columnsFor(measure(scale, width), count);
      return { scale, columns, height: Math.max(0, ...columns.map(column => column.reduce((sum, day) => sum + day.height, 0))) };
    };
    const full = candidate(1);
    if (full.height <= available) return full;
    let low = 0.001, high = 1, best = candidate(low);
    for (let i = 0; i < 22; i++) {
      const trial = candidate((low + high) / 2);
      if (trial.height <= available) { best = trial; low = trial.scale; } else high = trial.scale;
    }
    return best;
  };
  let fitted = fit(1);
  if (fitted.scale < 0.85 && days.length > 1) {
    const twoColumns = fit(2);
    if (twoColumns.scale > fitted.scale) fitted = twoColumns;
  }
  const scale = fitted.scale;
  fitted.columns.forEach((column, columnIndex) => {
    center = fitted.columns.length === 1 ? CENTER : columnIndex === 0 ? 58 : 152;
    y = bodyTop;
    for (const day of column) {
      style(6.8 * scale, colors.navy, true, 0.7 * scale); centered(day.headings, y);
      pdf.setDrawColor(...colors.light); pdf.setLineWidth(0.14);
      const underline = y + scale * (1.8 + (day.headings.length - 1) * 2.7);
      pdf.line(center - 3, underline, center + 3, underline);
      y += day.headingHeight;
      for (const meal of day.blocks) {
        if (meal.label) { style(5.8 * scale, colors.light, true, 0.45 * scale); centered(meal.label, y + 1.8 * scale); y += 3.3 * scale; }
        style(12.4 * scale);
        for (const line of meal.names) { centered(line, y + 4.2 * scale); y += 4.6 * scale; }
        if (meal.description.length) { y += 0.4 * scale; style(7.8 * scale, colors.muted); for (const line of meal.description) { centered(line, y + 2.6 * scale); y += 3.1 * scale; } }
        if (meal.notes.length) { y += 0.4 * scale; style(6.6 * scale, colors.muted); for (const line of meal.notes) { centered(line, y + 2.3 * scale); y += 2.7 * scale; } }
        y += 0.8 * scale;
      }
      y += 2.8 * scale;
    }
  });
  return pdf;
}
