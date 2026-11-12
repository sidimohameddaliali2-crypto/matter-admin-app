export const servicePages = [
  ['chats', 'Inbox'],
  ['problems', 'Follow-ups'],
  ['customers', 'Customers'],
  ['reviews', 'Reviews'],
  ['summary', 'Summary'],
  ['reporting', 'Reporting'],
];

export function servicePageForPath(pathname) {
  if (!/^\/customer-service(?:\/|$)/.test(pathname)) return null;
  const key = pathname.split('/')[2] || 'chats';
  return servicePages.find(([id]) => id === key) || [null, 'Customer service'];
}
