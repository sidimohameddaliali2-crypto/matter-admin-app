export const PARTNER_MEAL_LABELS = { breakfast: 'Breakfast of the day', main: 'Main', snack: 'Snack', bowl: 'Bowl', 'wraps-buns': 'Wraps/Buns', oats: 'Oats' };

export async function loadPartnerKitchenOrders(api, date, current = () => true) {
  const response = await api.get('/menus/kitchen-partner-orders', { params: { date } });
  const data = response.data?.data;
  if (!current()) throw new Error('The selected kitchen date changed. Please retry the download.');
  if (!response.data?.success || data?.date !== date || !Array.isArray(data.orders) || !Array.isArray(data.counts)
    || data.orders.some(order => !Array.isArray(order.lines))) throw new Error('Partner kitchen orders could not be verified. Please retry.');
  return data;
}

export const partnerCountingRows = data => data.counts.map(item => ({
  Category: 'Partner order', 'Meal Name': item.name, Count: item.quantity,
  'Total Protein Weight (g)': '', 'Total Carb Weight (g)': '', 'Total Veg Weight (g)': ''
}));
export const partnerPaperRows = data => data.orders.flatMap(order => order.lines.map(item => ({
  Section: 'Partner', 'Delivery address': order.deliveryAddress || '', 'Recipient phone': order.deliveryRecipientPhone || '', 'Delivery time': order.deliveryTime || '', Customer: order.partnerName,
  Type: PARTNER_MEAL_LABELS[item.mealType] || item.mealType, Meal: item.name,
  Quantity: item.quantity, Order: order.reference, Note: order.notes || ''
})));

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const partnerPaperHtml = data => !data.orders.length ? '' : `<section style="page-break-before:always"><h2>Partner</h2>${data.orders.map(order =>
  `<h3>${esc(order.partnerName)}</h3><p>${esc(order.reference)} · ${esc(order.deliveryTime)}</p>${order.deliveryAddress || order.deliveryRecipientPhone ? `<p>Delivery: ${esc([order.deliveryAddress, order.deliveryRecipientPhone].filter(Boolean).join(' · '))}</p>` : ''}${order.notes ? `<p>Notes: ${esc(order.notes)}</p>` : ''}<table border="1" cellspacing="0" cellpadding="5" style="width:100%;border-collapse:collapse"><thead><tr><th>Type</th><th>Meal</th><th>Quantity</th></tr></thead><tbody>${order.lines.map(item => `<tr><td>${esc(PARTNER_MEAL_LABELS[item.mealType] || item.mealType)}</td><td>${esc(item.name)}</td><td>${esc(item.quantity)}</td></tr>`).join('')}</tbody></table>`).join('')}</section>`;

export function appendPartnerPaperPdf(doc, autoTable, data) {
  if (!data.orders.length) return;
  doc.addPage();
  doc.setFontSize(17.5); doc.setFont(undefined, 'bold'); doc.text('Partner', 14, 20); doc.setFont(undefined, 'normal');
  autoTable(doc, {
    startY: 28, head: [['Partner', 'Order / Window', 'Type', 'Meal', 'Quantity', 'Notes']],
    body: data.orders.flatMap(order => order.lines.map(item => [order.partnerName, [order.reference, order.deliveryTime].filter(Boolean).join(' / '), PARTNER_MEAL_LABELS[item.mealType] || item.mealType, item.name, item.quantity, [order.deliveryAddress ? 'Delivery: ' + order.deliveryAddress : '', order.deliveryRecipientPhone ? 'Recipient: ' + order.deliveryRecipientPhone : '', order.notes || ''].filter(Boolean).join('\n')])),
    theme: 'grid', styles: {fontSize: 10, cellPadding: 2.2}, headStyles: {fillColor: [30, 41, 59]}, margin: {left: 14, right: 14}
  });
}
