export function dubaiDateKey(value = new Date()) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export const collectionIsOpen = status => ['pending', 'assigned', 'on_route', 'picked_up', 'failed'].includes(status);
export function waitingDays(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  return Math.max(0, Math.round((Date.parse(dubaiDateKey()) - Date.parse(dubaiDateKey(value))) / 86400000));
}
export async function exportCollectionRows(api, params, fileName) {
  const response = await api.get('/collections/export', { params, responseType: 'blob' });
  const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
