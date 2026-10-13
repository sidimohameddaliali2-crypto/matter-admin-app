// Kitchen paper for ONE customer over a custom date range (PDF and Word).
//
// One page per delivery date, each laid out like the customer's block on the
// Day Kitchen Paper: name + delivery-time tag, address, plan line, exclusions,
// the day note, the meal table (with the LARGE breakfast tag) and total macros.
//
// Owner (2026-10-12): same rule as the Day paper — a date the customer has no
// active Matter delivery for is left out (listed on the first page instead).
// The customer's own Matter delivery dates (entry.deliveryDates) are used for
// that, so no extra Matter call is needed. Partner members are always kept.
// The sizes below are the "a little larger" print sizes (owner, 2026-10-12).

export const getCustomerPaperDays = ({ entry, fromKey, toKey, getDateKey }) => {
  const meals = entry?.selectedMeals || [];
  const keys = Array.from(new Set(meals.map((meal) => getDateKey(meal?.date))))
    .filter((key) => key && key !== 'unknown-date' && key >= fromKey && key <= toKey)
    .sort();
  const deliveryDates = Array.isArray(entry?.deliveryDates) ? new Set(entry.deliveryDates) : null;
  const days = [];
  const skipped = [];
  keys.forEach((key) => {
    if (!entry.partner && deliveryDates && !deliveryDates.has(key)) {
      skipped.push(key);
    } else {
      days.push({ dateKey: key, meals: meals.filter((meal) => getDateKey(meal?.date) === key) });
    }
  });
  return { days, skipped, deliveryKnown: !!deliveryDates };
};

const timeTagFor = (entry, { parseDeliveryHour, formatDeliveryHourLabel }) => {
  const hour = parseDeliveryHour(entry.deliveryWindow?.label);
  if (hour === 999) return { text: 'No delivery window', has: false };
  const label = formatDeliveryHourLabel(hour);
  return { text: /^\s*by\b/i.test(String(entry.deliveryWindow?.label || '')) ? `By ${label}` : label, has: true };
};

const orNA = (value) => (value === null || value === undefined || value === '' ? 'N/A' : value);
const breakfastLabelFor = (entry) => (entry.breakfastIncluded === null || entry.breakfastIncluded === undefined
  ? 'N/A'
  : (entry.breakfastIncluded ? 'Yes' : 'No'));
const isLargeBreakfast = (meal) => String(meal?.mealType || '').toLowerCase() === 'breakfast' && !!meal?.flags?.isLargeBreakfast;

export const downloadCustomerPaperPdf = async ({ entry, fromKey, toKey, helpers }) => {
  const { getDateKey, formatDateLabel, getMealLabel, mealRemarkText, exclusionsText, formatAddress, loadJsPDF, loadAutoTable } = helpers;
  const { days, skipped, deliveryKnown } = getCustomerPaperDays({ entry, fromKey, toKey, getDateKey });
  if (days.length === 0) return { ok: false, days, skipped };

  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([loadJsPDF(), loadAutoTable()]);
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const name = entry.customerName || entry.email || 'Unknown customer';
  const tag = entry.partner ? null : timeTagFor(entry, helpers);

  days.forEach((day, dayIndex) => {
    if (dayIndex > 0) doc.addPage();
    let y = 18;

    doc.setFontSize(17);
    doc.setFont(undefined, 'bold');
    doc.text(`Kitchen Prep Sheet — ${formatDateLabel(day.dateKey)}`, 14, y);
    doc.setFont(undefined, 'normal');
    y += 8;

    // Name + delivery-time tag
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    const tagWidth = tag ? doc.getTextWidth(tag.text) + 7 : 0;
    const tagX = pageWidth - 14 - tagWidth;
    doc.setFontSize(15);
    const nameLine = doc.splitTextToSize(name, (tag ? tagX - 3 : pageWidth - 14) - 14)[0];
    doc.text(nameLine, 14, y);
    if (tag) {
      doc.setFontSize(10);
      if (tag.has) doc.setFillColor(30, 41, 59); else doc.setFillColor(148, 163, 184);
      doc.roundedRect(tagX, y - 5.5, tagWidth, 8, 1.5, 1.5, 'F');
      doc.setTextColor(255);
      doc.text(tag.text, tagX + 3.5, y - 0.2);
      doc.setTextColor(0);
    }
    doc.setFont(undefined, 'normal');
    y += 7;

    doc.setFontSize(11);
    const subLine = entry.partner
      ? `Partner: ${entry.partner?.businessName || 'Partner'}`
      : `Address: ${formatAddress(entry.deliveryAddress)}`;
    const subLines = doc.splitTextToSize(subLine, pageWidth - 28);
    doc.text(subLines, 14, y);
    y += subLines.length * 5.2 + 0.8;

    doc.setFont(undefined, 'bold');
    const planLines = doc.splitTextToSize(
      `Plan: ${entry.planName || 'N/A'}  |  Meals/day: ${orNA(entry.mealsPerDay)}  |  Snacks/day: ${orNA(entry.snacksPerDay)}  |  Breakfast included: ${breakfastLabelFor(entry)}`,
      pageWidth - 28
    );
    doc.text(planLines, 14, y);
    y += planLines.length * 5.2 + 0.8;

    doc.setTextColor(190, 18, 60);
    const exclusionLines = doc.splitTextToSize(`Exclusions: ${exclusionsText(entry)}`, pageWidth - 28);
    doc.text(exclusionLines, 14, y);
    doc.setTextColor(0);
    y += exclusionLines.length * 5.2 + 0.8;

    const dayNote = (entry.dayNotes || []).find((note) => note.date === day.dateKey)?.note;
    if (dayNote) {
      doc.setTextColor(180, 83, 9);
      const noteLines = doc.splitTextToSize(`Note: ${dayNote}`, pageWidth - 28);
      doc.text(noteLines, 14, y);
      doc.setTextColor(0);
      y += noteLines.length * 5.2 + 0.8;
    }
    doc.setFont(undefined, 'normal');

    // First page only: the range, and any dates left out.
    if (dayIndex === 0) {
      doc.setFontSize(9.5);
      doc.setTextColor(110);
      const summary = [`Dates on this paper: ${days.map((d) => formatDateLabel(d.dateKey)).join(', ')}`];
      if (skipped.length > 0) summary.push(`Left out (no active Matter delivery): ${skipped.map((k) => formatDateLabel(k)).join(', ')}`);
      if (!deliveryKnown && !entry.partner) summary.push('Matter delivery dates were not available, so every date with meals is included.');
      const sumLines = doc.splitTextToSize(summary.join('   |   '), pageWidth - 28);
      doc.text(sumLines, 14, y);
      doc.setTextColor(0);
      y += sumLines.length * 4.6 + 1.5;
    }
    y += 2;

    const large = day.meals.map(isLargeBreakfast);
    autoTable(doc, {
      startY: y,
      head: [['Type', 'Meal', 'Remark', 'P', 'C', 'V']],
      body: day.meals.map((meal, i) => {
        const label = getMealLabel(meal);
        return [label.mealType, large[i] ? `${label.mealName}   [LARGE]` : label.mealName, mealRemarkText(meal), `${meal.proteinWeight || 0}g`, `${meal.carbWeight || 0}g`, `${meal.vegWeight || 0}g`];
      }),
      theme: 'grid',
      styles: { fontSize: 11, cellPadding: 2.4 },
      headStyles: { fillColor: [30, 41, 59] },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 2 && data.cell.raw) {
          data.cell.styles.textColor = [194, 65, 12];
          data.cell.styles.fontStyle = 'bold';
        }
        if (data.section === 'body' && large[data.row.index] && data.column.index <= 1) {
          data.cell.styles.textColor = [109, 40, 217];
          data.cell.styles.fontStyle = 'bold';
        }
      },
      margin: { left: 14, right: 14 }
    });
    y = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(13);
    doc.setFont(undefined, 'bold');
    doc.text(`Total Macros: C ${entry.macros?.C || 0} / P ${entry.macros?.P || 0} / F ${entry.macros?.F || 0}`, 14, y);
    doc.setFont(undefined, 'normal');
  });

  const totalPages = doc.getNumberOfPages();
  for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
    doc.setPage(pageNo);
    doc.setFontSize(8.5);
    doc.setTextColor(110);
    doc.text(`${name} — ${formatDateLabel(days[0].dateKey)}${days.length > 1 ? ` to ${formatDateLabel(days[days.length - 1].dateKey)}` : ''}`, 14, pageHeight - 7);
    doc.text(`Page ${pageNo} of ${totalPages}`, pageWidth - 14, pageHeight - 7, { align: 'right' });
    doc.setTextColor(0);
  }

  const safeName = String(name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'customer';
  doc.save(`kitchen-paper-${safeName}-${days[0].dateKey}${days.length > 1 ? `-to-${days[days.length - 1].dateKey}` : ''}.pdf`);
  return { ok: true, days, skipped };
};

export const downloadCustomerPaperWord = ({ entry, fromKey, toKey, helpers }) => {
  const { getDateKey, formatDateLabel, getMealLabel, mealRemarkText, exclusionsText, formatAddress } = helpers;
  const { days, skipped, deliveryKnown } = getCustomerPaperDays({ entry, fromKey, toKey, getDateKey });
  if (days.length === 0) return { ok: false, days, skipped };
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const name = entry.customerName || entry.email || 'Unknown customer';
  const tag = entry.partner ? null : timeTagFor(entry, helpers);
  const rangeLabel = `${formatDateLabel(days[0].dateKey)}${days.length > 1 ? ` to ${formatDateLabel(days[days.length - 1].dateKey)}` : ''}`;

  const pages = days.map((day, dayIndex) => {
    const rows = day.meals.map((meal) => {
      const label = getMealLabel(meal);
      const largeTag = isLargeBreakfast(meal)
        ? ' <span style="background:#6d28d9;color:#ffffff;font-size:9pt;font-weight:bold">&nbsp;LARGE&nbsp;</span>'
        : '';
      return `<tr><td>${esc(label.mealType)}</td><td>${esc(label.mealName)}${largeTag}</td>`
        + `<td style="color:#c2410c;font-weight:bold">${esc(mealRemarkText(meal))}</td>`
        + `<td>${esc(meal.proteinWeight || 0)}g</td><td>${esc(meal.carbWeight || 0)}g</td><td>${esc(meal.vegWeight || 0)}g</td></tr>`;
    }).join('');
    const dayNote = (entry.dayNotes || []).find((note) => note.date === day.dateKey)?.note;
    const summary = [];
    if (dayIndex === 0) {
      summary.push(`Dates on this paper: ${days.map((d) => formatDateLabel(d.dateKey)).join(', ')}`);
      if (skipped.length > 0) summary.push(`Left out (no active Matter delivery): ${skipped.map((k) => formatDateLabel(k)).join(', ')}`);
      if (!deliveryKnown && !entry.partner) summary.push('Matter delivery dates were not available, so every date with meals is included.');
    }
    // The page break goes on this first paragraph only (Word applies it to every
    // child if it is put on a wrapping div).
    return `
      <h1 style="font-size:18pt;margin:0;${dayIndex > 0 ? 'page-break-before:always' : ''}">Kitchen Prep Sheet — ${esc(formatDateLabel(day.dateKey))}</h1>
      <p style="margin:8pt 0 0 0;font-size:15pt"><b>${esc(name)}</b>${tag ? ` &nbsp;&nbsp;<span style="background:${tag.has ? '#1e293b' : '#94a3b8'};color:#ffffff;font-size:10pt;font-weight:bold">&nbsp;${esc(tag.text)}&nbsp;</span>` : ''}</p>
      <p style="margin:0;font-size:11pt">${esc(entry.partner ? `Partner: ${entry.partner?.businessName || 'Partner'}` : `Address: ${formatAddress(entry.deliveryAddress)}`)}</p>
      <p style="margin:0;font-size:11pt"><b>Plan: ${esc(entry.planName || 'N/A')} | Meals/day: ${esc(orNA(entry.mealsPerDay))} | Snacks/day: ${esc(orNA(entry.snacksPerDay))} | Breakfast included: ${breakfastLabelFor(entry)}</b></p>
      <p style="margin:0;font-size:11pt;color:#be123c"><b>Exclusions: ${esc(exclusionsText(entry))}</b></p>
      ${dayNote ? `<p style="margin:0;font-size:11pt;color:#b45309"><b>Note: ${esc(dayNote)}</b></p>` : ''}
      ${summary.length ? `<p style="margin:4pt 0 0 0;font-size:9.5pt;color:#787878">${esc(summary.join('   |   '))}</p>` : ''}
      <table border="1" cellspacing="0" cellpadding="5" style="border-collapse:collapse;width:100%;font-size:11pt;margin-top:8pt">
        <tr style="background:#1e293b;color:#ffffff"><th>Type</th><th>Meal</th><th>Remark</th><th>P</th><th>C</th><th>V</th></tr>
        ${rows}
      </table>
      <p style="margin:8pt 0 0 0;font-size:13pt"><b>Total Macros: C ${entry.macros?.C || 0} / P ${entry.macros?.P || 0} / F ${entry.macros?.F || 0}</b></p>`;
  }).join('');

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Kitchen Prep Sheet</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
body{font-family:Arial,sans-serif} th,td{text-align:left}
@page WordSection1 { size:595.3pt 841.9pt; margin:54pt 54pt 60pt 54pt; mso-footer:f1; }
div.WordSection1 { page:WordSection1; }
p.MsoFooter { margin:0; font-size:8pt; color:#787878; text-align:right; }
</style></head>
<body>
<div class="WordSection1">${pages}</div>
<div style="mso-element:footer" id="f1"><p class="MsoFooter" style="text-align:right">${esc(name)} — ${esc(rangeLabel)} &nbsp;|&nbsp; Page <span style="mso-field-code:' PAGE '"></span> of <span style="mso-field-code:' NUMPAGES '"></span></p></div>
</body></html>`;

  const blob = new Blob(['\uFEFF', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeName = String(name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'customer';
  link.href = url;
  link.download = `kitchen-paper-${safeName}-${days[0].dateKey}${days.length > 1 ? `-to-${days[days.length - 1].dateKey}` : ''}.doc`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true, days, skipped };
};
